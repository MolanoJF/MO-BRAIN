import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

installOpsMock();

const { buildZoneFixture } = await import('../helpers/zoneFixture.ts');
const { bearerFor, clientIdOf, rpc } = await import('../helpers/controlMcp.ts');
const { controlMcpRoutes, defaultControlMcpDeps } = await import('../../src/control/routes/controlMcp.ts');
const { createLimiter } = await import('../../src/control/mcp/rateLimit.ts');
const { clearCallerCache } = await import('../../src/control/mcp/caller.ts');
const { default: app } = await import('../../src/control/app.ts');
const { getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { eq } = await import('drizzle-orm');
const { Hono } = await import('hono');

pinDb();

let fx: Awaited<ReturnType<typeof buildZoneFixture>>;
let alice = '';

beforeAll(async () => {
  fx = await buildZoneFixture();
  alice = bearerFor(await clientIdOf(fx.alice.privateConnectionId));
});
beforeEach(() => clearCallerCache());
afterAll(async () => { await closeDb(); });

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };

describe('POST /api/control-mcp', () => {
  test('a resolved bearer can initialize', async () => {
    const res = await rpc(alice, init);
    expect(res.status).toBe(200);
    expect((await res.json() as any).result.serverInfo.name).toBe('mobrain-control');
  });

  test('no bearer is 401 with WWW-Authenticate', async () => {
    const res = await rpc(null, init);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  });

  test('Review focus 5: a console session cookie alone never authenticates', async () => {
    const res = await rpc(null, init, { cookie: fx.owner.cookie });
    expect(res.status).toBe(401);
  });

  test('Review focus 1: an expired or invalid token is 401 with a reissue hint', async () => {
    const res = await rpc('expired-or-garbage-token', init);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    const body = await res.json() as { error: string; hint: string };
    expect(body.error).toBe('invalid_token');
    expect(body.hint).toContain('/my/mcp');
  });

  test('Review focus 5: a cross-origin browser request is refused before identity', async () => {
    const res = await rpc(alice, init, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin_not_allowed' });
  });

  test('the install origin itself is allowed', async () => {
    const res = await rpc(alice, init, { origin: new URL(process.env.PUBLIC_URL!).origin });
    expect(res.status).toBe(200);
  });

  test('D5: a runner token is 403 and audited as control_mcp.refused', async () => {
    await getDb().update(schema.connections).set({ serverClientId: 'gbrain_cl_server_alice' })
      .where(eq(schema.connections.id, fx.alice.privateConnectionId));
    const res = await rpc(bearerFor('gbrain_cl_server_alice'), init);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'runner_token' });
    const rows = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'control_mcp.refused'));
    expect(rows.some((r) => (r.after as any).error === 'runner_token')).toBe(true);
  });

  test('an unknown OAuth client is 403', async () => {
    expect((await rpc(bearerFor('gbrain_cl_nobody'), init)).status).toBe(403);
  });

  test('D7: a tools/call without a name is -32602 and still audited', async () => {
    await getDb().delete(schema.auditLog).where(eq(schema.auditLog.action, 'control_mcp.call'));
    const res = await rpc(alice, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { arguments: { secret: 'never-store-me' } } });
    expect(res.status).toBe(200);
    expect((await res.json() as any).error.code).toBe(-32602);
    const rows = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'control_mcp.call'));
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.actor).toBe(fx.alice.userId);
    expect(row.target).toBeNull();
    const after = row.after as Record<string, unknown>;
    expect(after).toMatchObject({ outcome: 'refused', error: 'invalid_arguments', argKeys: ['secret'] });
    expect(after.via as string).toMatch(/^control-mcp:/);
    expect(JSON.stringify(after)).not.toContain('never-store-me');
  });

  test('a notification is 202', async () => {
    const res = await rpc(alice, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  test('bad JSON is -32700, a batch is -32600', async () => {
    const parse = await rpc(alice, '{not json');
    expect(parse.status).toBe(400);
    expect((await parse.json() as any).error.code).toBe(-32700);
    const batch = await rpc(alice, [init]);
    expect(batch.status).toBe(400);
    expect((await batch.json() as any).error.code).toBe(-32600);
  });

  test('GET is 405', async () => {
    const res = await app.request('/api/control-mcp', { headers: { authorization: `Bearer ${alice}` } });
    expect(res.status).toBe(405);
  });

  test('a bearer over its bucket is 429 with Retry-After', async () => {
    const tiny = new Hono();
    tiny.route('/api', controlMcpRoutes((req, env) => app.fetch(req, env as never), {
      ...defaultControlMcpDeps(), limiter: createLimiter({ capacity: 2, refillPerSec: 0.01 }),
    }));
    const call = () => tiny.request('/api/control-mcp', {
      method: 'POST', headers: { authorization: `Bearer ${alice}`, 'content-type': 'application/json' },
      body: JSON.stringify(init),
    });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const third = await call();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });
});
