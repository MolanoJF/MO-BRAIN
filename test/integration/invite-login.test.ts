// test/integration/invite-login.test.ts
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

installOpsMock();

const { getDb, schema, closeDb, pinDb, runMigrations } = await import('../../src/control/db/client.ts');
const { bootstrapFirstAdmin } = await import('../../src/control/bootstrap.ts');
const { hit, PASS } = await import('../helpers/zoneFixture.ts');
const { sql, eq } = await import('drizzle-orm');

pinDb();
let ownerCookie = '';

beforeAll(async () => {
  await runMigrations();
  await getDb().execute(sql`TRUNCATE users, organizations, runner_presence RESTART IDENTITY CASCADE`);
  await bootstrapFirstAdmin('il-owner@example.test', PASS, 'InviteCo', { brainMode: 'company' });
  const res = await hit('POST', '/api/auth/sign-in/email', undefined, { email: 'il-owner@example.test', password: PASS });
  ownerCookie = res.headers.get('set-cookie') ?? '';
}, 90_000);

afterAll(async () => { await closeDb(); });

async function invite(email: string): Promise<{ membershipId: string; token: string }> {
  const created = await hit('POST', '/api/members', ownerCookie, { email, role: 'member' });
  expect(created.status).toBe(200);
  const { id } = await created.json() as { id: string };
  const link = await hit('POST', `/api/members/${id}/claim-link`, ownerCookie, { email });
  expect(link.status).toBe(200);
  const { token } = await link.json() as { token: string };
  return { membershipId: id, token };
}

describe('invite accounts', () => {
  test('a brand-new invitee gets a placeholder account', async () => {
    await invite('il-new@example.test');
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.email, 'il-new@example.test'));
    expect(u?.invitePlaceholder).toBe(true);
  });

  test('inviting someone who already has an account does not mark it', async () => {
    const [owner] = await getDb().select().from(schema.users).where(eq(schema.users.email, 'il-owner@example.test'));
    expect(owner?.invitePlaceholder).toBe(false);
  });
});
