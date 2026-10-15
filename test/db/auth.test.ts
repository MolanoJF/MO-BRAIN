// test/db/auth.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { freshDb, type Sql } from './helpers.ts';
import {
  createApiKey, createSession, deleteSession, hashPassword, loginWithPassword,
  userForApiKey, userForSession, LoginThrottle,
} from '../../src/server/auth.ts';

let sql: Sql; let drop: () => Promise<void>; let userId: string;
beforeAll(async () => {
  ({ sql, drop } = await freshDb());
  const [u] = await sql<{ id: string }[]>`insert into users (email, role, status, password_hash)
    values ('Ada@X.io', 'owner', 'active', ${await hashPassword('correct horse')}) returning id`;
  userId = u!.id;
});
afterAll(async () => drop());

describe('password login', () => {
  test('accepts the right password, case-insensitive email', async () => {
    const u = await loginWithPassword(sql, 'ada@x.io', 'correct horse');
    expect(u?.id).toBe(userId);
  });
  test('rejects a wrong password', async () => {
    expect(await loginWithPassword(sql, 'ada@x.io', 'nope')).toBeNull();
  });
  test('rejects a disabled user', async () => {
    await sql`update users set status = 'disabled' where id = ${userId}`;
    expect(await loginWithPassword(sql, 'ada@x.io', 'correct horse')).toBeNull();
    await sql`update users set status = 'active' where id = ${userId}`;
  });
});

describe('sessions', () => {
  test('create, look up, delete', async () => {
    const token = await createSession(sql, userId, new Date());
    expect((await userForSession(sql, token, new Date()))?.id).toBe(userId);
    await deleteSession(sql, token);
    expect(await userForSession(sql, token, new Date())).toBeNull();
  });
  test('an expired session is not valid', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const token = await createSession(sql, userId, t0);
    expect(await userForSession(sql, token, new Date('2026-03-01T00:00:00Z'))).toBeNull();
  });
  test('only the hash is stored', async () => {
    const token = await createSession(sql, userId, new Date());
    const rows = await sql`select id_hash from sessions`;
    expect(rows.some((r) => r.idHash === token)).toBe(false);
  });
});

describe('api keys', () => {
  test('create and resolve; revoked keys do not resolve', async () => {
    const key = await createApiKey(sql, userId, 'cli');
    expect(key.startsWith('mbk_')).toBe(true);
    expect((await userForApiKey(sql, key))?.id).toBe(userId);
    await sql`update api_keys set revoked_at = now()`;
    expect(await userForApiKey(sql, key)).toBeNull();
  });
});

describe('LoginThrottle', () => {
  test('locks an email after 10 failures in 15 minutes', () => {
    const t = new LoginThrottle();
    const now = Date.now();
    for (let i = 0; i < 10; i++) t.fail('a@x.io', now);
    expect(t.locked('a@x.io', now)).toBe(true);
    expect(t.locked('a@x.io', now + 16 * 60_000)).toBe(false);
  });
});
