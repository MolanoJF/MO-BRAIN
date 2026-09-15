import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import app from '../../src/control/app.ts';
import { runMigrations, getDb, schema, closeDb } from '../../src/control/db/client.ts';
import { isBootstrapped } from '../../src/control/bootstrap.ts';

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(48);
  process.env.BETTER_AUTH_SECRET = 'b'.repeat(48);
  if (!process.env.CONTROL_DATABASE_URL) {
    process.env.CONTROL_DATABASE_URL =
      'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
  }
  await runMigrations();
  // Child tables first — FKs to users/orgs.
  await getDb().delete(schema.sessions);
  await getDb().delete(schema.accounts);
  await getDb().delete(schema.verifications);
  await getDb().delete(schema.auditLog);
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
