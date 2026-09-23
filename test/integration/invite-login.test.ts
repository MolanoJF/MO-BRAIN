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

describe('claiming sets a real login', () => {
  test('a too-short password is refused and does NOT burn the link', async () => {
    const { token } = await invite('il-short@example.test');
    const bad = await hit('POST', `/api/claim/${token}`, undefined, { email: 'il-short@example.test', password: 'short' });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toBe('password_too_short');

    const good = await hit('POST', `/api/claim/${token}`, undefined, { email: 'il-short@example.test', password: PASS });
    expect(good.status).toBe(200);
  });

  test('a new invitee claims with a password, then signs in with it', async () => {
    const { token } = await invite('il-claim@example.test');
    const res = await hit('POST', `/api/claim/${token}`, undefined, { email: 'il-claim@example.test', password: 'my-own-password-123' });
    expect(res.status).toBe(200);
    expect((await res.json() as { account: string }).account).toBe('created');

    const signIn = await hit('POST', '/api/auth/sign-in/email', undefined, { email: 'il-claim@example.test', password: 'my-own-password-123' });
    expect(signIn.status).toBe(200);

    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.email, 'il-claim@example.test'));
    expect(u?.invitePlaceholder).toBe(false);
    expect(u?.emailVerified).toBe(true);
  });

  test("a claim never changes the password of an account the person already had", async () => {
    // Create a real account first, then invite that same email.
    const signUp = await hit('POST', '/api/auth/sign-up/email', undefined, { email: 'il-existing@example.test', password: PASS, name: 'x' });
    expect(signUp.status).toBe(200);
    const { token } = await invite('il-existing@example.test');

    const res = await hit('POST', `/api/claim/${token}`, undefined, { email: 'il-existing@example.test', password: 'attacker-chosen-pass' });
    expect(res.status).toBe(200);
    expect((await res.json() as { account: string }).account).toBe('existing');

    const oldStillWorks = await hit('POST', '/api/auth/sign-in/email', undefined, { email: 'il-existing@example.test', password: PASS });
    expect(oldStillWorks.status).toBe(200);
    const newDoesNot = await hit('POST', '/api/auth/sign-in/email', undefined, { email: 'il-existing@example.test', password: 'attacker-chosen-pass' });
    expect(newDoesNot.status).not.toBe(200);
  });

  test('a claim without a password behaves as before', async () => {
    const { token } = await invite('il-nopass@example.test');
    const res = await hit('POST', `/api/claim/${token}`, undefined, { email: 'il-nopass@example.test' });
    expect(res.status).toBe(200);
    expect((await res.json() as { account: string }).account).toBe('unchanged');
  });
});
