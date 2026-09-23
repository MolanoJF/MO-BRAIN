// test/integration/mode.test.ts
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

installOpsMock();

const { getDb, schema, closeDb, pinDb, runMigrations } = await import('../../src/control/db/client.ts');
const { bootstrapFirstAdmin } = await import('../../src/control/bootstrap.ts');
const { hit, PASS } = await import('../helpers/zoneFixture.ts');
const { sql, eq } = await import('drizzle-orm');

pinDb();
let orgId = '';
let ownerCookie = '';

beforeAll(async () => {
  await runMigrations();
  await getDb().execute(sql`TRUNCATE users, organizations, runner_presence RESTART IDENTITY CASCADE`);
  ({ orgId } = await bootstrapFirstAdmin('mode-owner@example.test', PASS, 'Solo')); // personal
  const res = await hit('POST', '/api/auth/sign-in/email', undefined, { email: 'mode-owner@example.test', password: PASS });
  ownerCookie = res.headers.get('set-cookie') ?? '';
}, 90_000);

afterAll(async () => { await closeDb(); });

describe('personal mode refuses team routes', () => {
  test('invite, shared source and grants answer company_mode_required', async () => {
    for (const [method, path, body] of [
      ['POST', '/api/members', { email: 'x@example.test', role: 'member' }],
      ['POST', '/api/sources', { sourceId: 'shared-kb', name: 'Shared' }],
      ['PUT', '/api/grants', { membershipId: 'm', spaceId: 's', access: 'read' }],
    ] as const) {
      const res = await hit(method, path, ownerCookie, body);
      expect(res.status).toBe(403);
      expect((await res.json() as { error: string }).error).toBe('company_mode_required');
    }
  });

  test('the same routes open once the org is in company mode', async () => {
    await getDb().update(schema.organizations).set({ brainMode: 'company' }).where(eq(schema.organizations.id, orgId));
    const res = await hit('POST', '/api/members', ownerCookie, { email: 'y@example.test', role: 'member' });
    expect(res.status).toBe(200);
    await getDb().update(schema.organizations).set({ brainMode: 'personal' }).where(eq(schema.organizations.id, orgId));
  });
});

describe('/api/org', () => {
  test('GET reports personal mode and its capabilities', async () => {
    const body = await (await hit('GET', '/api/org', ownerCookie)).json() as {
      brainMode: string; capabilities: Record<string, boolean>; memberCount: number; role: string;
    };
    expect(body.brainMode).toBe('personal');
    expect(body.capabilities.invite).toBe(false);
    expect(body.role).toBe('owner');
  });

  test('the owner switches to company and renames in one step', async () => {
    const res = await hit('PATCH', '/api/org/mode', ownerCookie, { mode: 'company', name: 'Acme Inc' });
    expect(res.status).toBe(200);
    const body = await (await hit('GET', '/api/org', ownerCookie)).json() as { brainMode: string; name: string };
    expect(body.brainMode).toBe('company');
    expect(body.name).toBe('Acme Inc');
  });

  test('switching back is refused once anyone else is a member', async () => {
    // `y@example.test` was invited in the previous describe → 2+ memberships.
    const res = await hit('PATCH', '/api/org/mode', ownerCookie, { mode: 'personal' });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe('team_exists');
  });

  test('switching back is allowed while solo with no open invite', async () => {
    const [owner] = await getDb().select().from(schema.users).where(eq(schema.users.email, 'mode-owner@example.test'));
    await getDb().execute(sql`DELETE FROM claim_links WHERE organization_id = ${orgId}`);
    await getDb().execute(sql`DELETE FROM memberships WHERE organization_id = ${orgId} AND user_id <> ${owner!.id}`);
    const res = await hit('PATCH', '/api/org/mode', ownerCookie, { mode: 'personal' });
    expect(res.status).toBe(200);
  });

  test('an unknown mode is rejected', async () => {
    expect((await hit('PATCH', '/api/org/mode', ownerCookie, { mode: 'enterprise' })).status).toBe(400);
  });
});
