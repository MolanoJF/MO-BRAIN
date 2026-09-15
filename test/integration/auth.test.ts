import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import app from '../../src/control/app.ts';
import { runMigrations, getDb, schema, closeDb, pinDb } from '../../src/control/db/client.ts';
import { isBootstrapped } from '../../src/control/bootstrap.ts';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
// Pin at module load so a sibling file cannot close the pool before our beforeAll.
pinDb();

const PASS = 'a-long-enough-password';

/** Tables declared in src/control/db/schema.ts, plus drizzle's migrator ledger. */
const DECLARED_TABLES = new Set([
  'users', 'sessions', 'accounts', 'verifications',
  'organizations', 'memberships', 'brains', 'spaces', 'secrets',
  'capability_snapshots', 'playbook_ledger', 'audit_log',
  'connections', 'claim_links',
  '__drizzle_migrations',
]);

function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; errno?: string; cause?: { code?: string; errno?: string } };
  return err.errno ?? err.code ?? err.cause?.errno ?? err.cause?.code;
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie') ?? '';
}

async function wizardState(cookie: string) {
  return app.request('/api/wizard/state', { headers: { cookie } });
}

beforeAll(async () => {
  await runMigrations();
  // Child tables first — FKs to users/orgs. claim_links and connections
  // reference memberships/orgs (Task 1); delete them before those parents.
  await getDb().delete(schema.sessions);
  await getDb().delete(schema.accounts);
  await getDb().delete(schema.verifications);
  await getDb().delete(schema.auditLog);
  await getDb().delete(schema.claimLinks);
  await getDb().delete(schema.connections);
  await getDb().delete(schema.memberships);
  await getDb().delete(schema.brains);
  await getDb().delete(schema.organizations);
  await getDb().delete(schema.users);
}, 60_000);

afterAll(async () => {
  await closeDb();
});

describe('single-admin bootstrap', () => {
  test('an empty install reports itself un-bootstrapped', async () => {
    expect(await isBootstrapped()).toBe(false);
  });

  test('the bootstrap endpoint is open only while un-bootstrapped', async () => {
    const res = await app.request('/api/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.test', password: 'a-long-enough-password', orgName: 'Acme' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { orgId?: string; brainId?: string };
    expect(body.orgId).toBeTruthy();
    expect(body.brainId).toBeTruthy();
  });

  test('bootstrap creates an owner membership and an uninitialized brain', async () => {
    const [m] = await getDb().select().from(schema.memberships);
    expect(m?.role).toBe('owner');
    const [b] = await getDb().select().from(schema.brains);
    expect(b?.lifecycle).toBe('uninitialized');
  });

  // Company-first, personal derived: one org, one membership, one grant.
  test('the org defaults to company mode', async () => {
    const [o] = await getDb().select().from(schema.organizations);
    expect(o?.brainMode).toBe('company');
  });

  test('a second bootstrap attempt is refused', async () => {
    const res = await app.request('/api/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'other@example.test', password: 'another-long-password', orgName: 'Other' }),
    });
    expect(res.status).toBe(409);
  });

  test('bootstrap never echoes the password back', async () => {
    const [u] = await getDb().select().from(schema.users);
    expect(JSON.stringify(u)).not.toContain('a-long-enough-password');
  });

  // Ruling 25 reversal (Task 9): wizard is mounted; unauthenticated → 401.
  test('an unauthenticated wizard call is 401', async () => {
    expect((await app.request('/api/wizard/state')).status).toBe(401);
  });
});

describe('roles', () => {
  let orgId = '';
  let ownerCookie = '';
  let adminCookie = '';
  let memberCookie = '';
  let viewerCookie = '';

  beforeAll(async () => {
    const [org] = await getDb().select().from(schema.organizations);
    orgId = org!.id;

    for (const { email, role } of [
      { email: 'role-admin@example.test', role: 'admin' as const },
      { email: 'role-member@example.test', role: 'member' as const },
      { email: 'role-viewer@example.test', role: 'viewer' as const },
    ]) {
      const signed = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASS, name: email }),
      });
      expect(signed.status).toBe(200);
      const [u] = await getDb().select().from(schema.users).where(eq(schema.users.email, email));
      await getDb().insert(schema.memberships).values({
        id: randomUUID(), userId: u!.id, organizationId: orgId, role,
      });
    }

    ownerCookie = await signIn('admin@example.test', PASS);
    adminCookie = await signIn('role-admin@example.test', PASS);
    memberCookie = await signIn('role-member@example.test', PASS);
    viewerCookie = await signIn('role-viewer@example.test', PASS);
  });

  test('a viewer gets 403 from an admin route', async () => {
    expect((await wizardState(viewerCookie)).status).toBe(403);
  });

  test('a member gets 403 from an admin route', async () => {
    expect((await wizardState(memberCookie)).status).toBe(403);
  });

  test('an owner passes an admin route', async () => {
    expect((await wizardState(ownerCookie)).status).toBe(200);
  });

  test('an admin passes an admin route', async () => {
    expect((await wizardState(adminCookie)).status).toBe(200);
  });

  test('a comma-joined role string is rejected by the role_valid CHECK', async () => {
    const otherId = randomUUID();
    await getDb().insert(schema.organizations).values({
      id: otherId, name: 'Comma', slug: `comma-${otherId.slice(0, 8)}`,
    });
    const [owner] = await getDb().select().from(schema.users)
      .where(eq(schema.users.email, 'admin@example.test'));
    let err: unknown;
    try {
      await getDb().insert(schema.memberships).values({
        id: randomUUID(), userId: owner!.id, organizationId: otherId, role: 'admin,member',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(pgCode(err)).toBe('23514');
    const cause = (err as { cause?: unknown }).cause;
    expect(`${String(err)} ${String(cause ?? '')}`).toContain('role_valid');
  });

  test('the organization plugin invitation surface is not mounted', async () => {
    const listed = await app.request('/api/auth/organization/list', {
      headers: { cookie: ownerCookie },
    });
    expect(listed.status).toBe(404);

    const invite = await app.request('/api/auth/organization/invite-member', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ email: 'invitee@example.test', role: 'member' }),
    });
    expect(invite.status).toBe(404);

    const rows = await getDb().execute(
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const extras = [...rows]
      .map((r) => String((r as { table_name: string }).table_name))
      .filter((t) => !DECLARED_TABLES.has(t));
    expect(extras).toEqual([]);
  });

  test('active organization id selects among multiple memberships', async () => {
    const orgB = randomUUID();
    await getDb().insert(schema.organizations).values({
      id: orgB, name: 'ViewerOrg', slug: `viewer-${orgB.slice(0, 8)}`,
    });

    const email = 'dual-role@example.test';
    const signed = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASS, name: email }),
    });
    expect(signed.status).toBe(200);
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.email, email));
    await getDb().insert(schema.memberships).values({
      id: randomUUID(), userId: u!.id, organizationId: orgId, role: 'admin',
    });
    await getDb().insert(schema.memberships).values({
      id: randomUUID(), userId: u!.id, organizationId: orgB, role: 'viewer',
    });

    const cookie = await signIn(email, PASS);

    await getDb().update(schema.sessions)
      .set({ activeOrganizationId: orgId })
      .where(eq(schema.sessions.userId, u!.id));
    expect((await wizardState(cookie)).status).toBe(200);

    await getDb().update(schema.sessions)
      .set({ activeOrganizationId: orgB })
      .where(eq(schema.sessions.userId, u!.id));
    expect((await wizardState(cookie)).status).toBe(403);

    await getDb().update(schema.sessions)
      .set({ activeOrganizationId: null })
      .where(eq(schema.sessions.userId, u!.id));
    expect((await wizardState(cookie)).status).toBe(403);
  });
});
