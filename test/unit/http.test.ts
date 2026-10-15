// test/unit/http.test.ts
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { HttpError, onError, requireRole, type AppEnv } from '../../src/server/http.ts';
import type { User } from '../../src/server/types.ts';

const user = (role: User['role']): User => ({ id: 'u', email: 'a@x.io', name: null, role, status: 'active', createdAt: new Date() });

function app(u: User | null) {
  const a = new Hono<AppEnv>();
  a.onError(onError);
  a.use('*', async (c, next) => { c.set('user', u); await next(); });
  a.get('/admins', requireRole('owner', 'admin'), (c) => c.json({ ok: true }));
  a.get('/boom', () => { throw new HttpError(409, 'conflict_thing', { a: 1 }); });
  return a;
}

describe('requireRole', () => {
  test('401 without a user', async () => {
    const r = await app(null).request('/admins');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthenticated' });
  });
  test('403 for a member', async () => {
    expect((await app(user('member')).request('/admins')).status).toBe(403);
  });
  test('200 for an admin', async () => {
    expect((await app(user('admin')).request('/admins')).status).toBe(200);
  });
});

describe('onError', () => {
  test('renders an HttpError as JSON with its code and detail', async () => {
    const r = await app(null).request('/boom');
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'conflict_thing', detail: { a: 1 } });
  });
});
