import { describe, expect, test } from 'bun:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??= 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
process.env.PUBLIC_URL ??= 'http://127.0.0.1:3131';

const { Hono } = await import('hono');
const { requireRole } = await import('../../src/control/rbac.ts');
const { controlEnv, controlCallerOf, guardMinOf } = await import('../../src/control/mcp/callerEnv.ts');
type Role = 'owner' | 'admin' | 'member' | 'viewer';

const app = new Hono();
app.get('/t/:min', async (c) => {
  try { return c.json(await requireRole(c, c.req.param('min') as Role)); }
  catch (r) { return r as Response; }
});

const caller = {
  userId: 'u1', orgId: 'o1', role: 'admin' as const,
  membershipId: 'm1', connectionId: 'c1', clientId: 'cl1',
};

describe('requireRole with a delegated control caller', () => {
  test('passes a guard at or below its role, with no session, and records the guard', async () => {
    const env = controlEnv(caller);
    const res = await app.request('/t/admin', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'u1', orgId: 'o1', role: 'admin' });
    expect(guardMinOf(env)).toBe('admin');
  });

  test('is refused a guard above its role, as the console would be', async () => {
    const env = controlEnv(caller);
    const res = await app.request('/t/owner', {}, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(guardMinOf(env)).toBe('owner');
  });

  test('a caller cannot be forged: a look-alike Symbol on env is ignored', async () => {
    const forged = { [Symbol('mobrain.controlCaller')]: caller, requestIP: () => null };
    const res = await app.request('/t/viewer', {}, forged);
    expect(res.status).toBe(401);
  });

  test('no env falls through to the session path (no cookie → 401)', async () => {
    const res = await app.request('/t/viewer');
    expect(res.status).toBe(401);
  });

  test('the delegated caller is frozen', () => {
    const env = controlEnv({ ...caller });
    const seen = controlCallerOf({ env } as never);
    expect(Object.isFrozen(seen)).toBe(true);
  });
});
