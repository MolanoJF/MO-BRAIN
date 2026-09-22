import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import app from '../../src/control/app.ts';
import { runMigrations, getDb, schema, closeDb, pinDb } from '../../src/control/db/client.ts';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
pinDb();

beforeAll(async () => {
  await runMigrations();
  await getDb().delete(schema.sessions);
  await getDb().delete(schema.accounts);
  await getDb().delete(schema.memberships);
  await getDb().delete(schema.brains);
  await getDb().delete(schema.organizations);
  await getDb().delete(schema.users);
}, 60_000);

afterAll(async () => { await closeDb(); });

describe('bootstrap via an existing session (the Google path)', () => {
  test('bootstrap refuses orgName-only with no session', async () => {
    const res = await app.request('/api/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'NoSessionCo' }),
    });
    expect(res.status).toBe(401);
  });

  test('bootstrap succeeds for orgName-only once a session exists', async () => {
    // Simulates "the browser already completed Google sign-in": a user row
    // and a session row, created directly — no password, no OAuth round trip.
    const userId = randomUUID();
    await getDb().insert(schema.users).values({
      id: userId, email: 'google-admin@example.test', name: 'Google Admin', emailVerified: true,
    });
    const token = randomUUID();
    await getDb().insert(schema.sessions).values({
      id: randomUUID(), userId, token,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await app.request('/api/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `better-auth.session_token=${token}` },
      body: JSON.stringify({ orgName: 'GoogleCo' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { orgId?: string; userId?: string };
    expect(body.orgId).toBeTruthy();
    expect(body.userId).toBe(userId);

    const [m] = await getDb().select().from(schema.memberships).where(eq(schema.memberships.userId, userId));
    expect(m?.role).toBe('owner');
  });
});
