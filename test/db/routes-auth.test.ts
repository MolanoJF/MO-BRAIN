// test/db/routes-auth.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { hashPassword } from '../../src/server/auth.ts';

let w: TestWorld;
beforeAll(async () => {
  w = await world();
  await w.sql`insert into users (email, role, status, password_hash) values ('ada@x.io', 'owner', 'active', ${await hashPassword('pw-123456')})`;
});
afterAll(async () => w.drop());

describe('auth routes', () => {
  test('login sets an HttpOnly session cookie and /api/me returns the user', async () => {
    const r = await w.req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'ada@x.io', password: 'pw-123456' }) });
    expect(r.status).toBe(200);
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toContain('mobrain_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    const token = /mobrain_session=([^;]+)/.exec(cookie)![1]!;
    const me = await (await w.req('/api/me', { as: token })).json();
    expect(me).toMatchObject({ user: { email: 'ada@x.io', role: 'owner' }, mode: 'personal' });
  });

  test('a wrong password is 401 with a generic error', async () => {
    const r = await w.req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'ada@x.io', password: 'x' }) });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'invalid_credentials' });
  });

  test('/api/me without a session is 401', async () => {
    expect((await w.req('/api/me')).status).toBe(401);
  });

  test('logout clears the session', async () => {
    const r = await w.req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'ada@x.io', password: 'pw-123456' }) });
    const token = /mobrain_session=([^;]+)/.exec(r.headers.get('set-cookie')!)![1]!;
    await w.req('/api/auth/logout', { method: 'POST', as: token });
    expect((await w.req('/api/me', { as: token })).status).toBe(401);
  });
});

describe('health', () => {
  test('public health reports ok and the pin match without auth', async () => {
    const r = await w.req('/api/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, db: true, pin: { expected: '0.60.230.0', running: '0.60.230.0', matches: true } });
  });
});
