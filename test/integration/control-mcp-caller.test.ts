import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

const ops = installOpsMock();

const { buildZoneFixture, insertAgentRun } = await import('../helpers/zoneFixture.ts');
const { clientIdOf } = await import('../helpers/controlMcp.ts');
const { resolveCaller, clearCallerCache } = await import('../../src/control/mcp/caller.ts');
const { getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { eq } = await import('drizzle-orm');

pinDb();

type Fx = Awaited<ReturnType<typeof buildZoneFixture>>;
let fx: Fx;

/** A whoami that answers `tok-<id>` as client `<id>` and counts calls. */
function fakeWhoami() {
  const calls: string[] = [];
  let clock = 1_000_000;
  return {
    calls,
    advance(ms: number) { clock += ms; },
    deps: {
      whoami: async (b: string) => {
        calls.push(b);
        return b.startsWith('tok-')
          ? { ok: true as const, identity: { transport: 'oauth', client_id: b.slice(4) } }
          : { ok: false as const, status: 401 as const, error: 'invalid_token' };
      },
      now: () => clock,
      ttlMs: 30_000,
    },
  };
}

beforeAll(async () => { fx = await buildZoneFixture(); });
beforeEach(() => { clearCallerCache(); ops.reset(); });
afterAll(async () => { await closeDb(); });

describe('resolveCaller', () => {
  test('a member Connection resolves to its human, with the membership role', async () => {
    const [conn] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, fx.alice.privateConnectionId));
    expect(conn!.state).toBe('active');
    const w = fakeWhoami();
    const r = await resolveCaller(`tok-${conn!.gbrainClientId}`, w.deps);
    expect(r).toEqual({ ok: true, caller: {
      userId: fx.alice.userId, orgId: fx.orgId, role: 'member',
      membershipId: fx.alice.membershipId, connectionId: fx.alice.privateConnectionId,
      clientId: conn!.gbrainClientId!,
    } });
  });

  test('owner and admin resolve to their roles', async () => {
    const w = fakeWhoami();
    const owner = await resolveCaller(`tok-${await clientIdOf(fx.owner.privateConnectionId)}`, w.deps);
    const admin = await resolveCaller(`tok-${await clientIdOf(fx.admin.privateConnectionId)}`, w.deps);
    expect(owner.ok && owner.caller.role).toBe('owner');
    expect(admin.ok && admin.caller.role).toBe('admin');
  });

  test('D5: the server-side minting client is a runner token, refused and attributable', async () => {
    await getDb().update(schema.connections).set({ serverClientId: 'gbrain_cl_server_bob' })
      .where(eq(schema.connections.id, fx.bob.privateConnectionId));
    const r = await resolveCaller('tok-gbrain_cl_server_bob', fakeWhoami().deps);
    expect(r).toEqual({ ok: false, status: 403, error: 'runner_token',
      audit: { orgId: fx.orgId, actor: `connection-server:${fx.bob.privateConnectionId}`, clientId: 'gbrain_cl_server_bob' } });
  });

  test('D5: a per-run token is refused', async () => {
    const { runId } = await insertAgentRun(fx.orgId, fx.bob.privateConnectionId, 'probe-run');
    await getDb().update(schema.agentRuns).set({ gbrainClientId: 'gbrain_cl_run_1' })
      .where(eq(schema.agentRuns.runId, runId));
    const r = await resolveCaller('tok-gbrain_cl_run_1', fakeWhoami().deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('runner_token');
      expect(r.audit?.actor).toBe(`run:${runId}`);
    }
  });

  test('an OAuth client no Connection knows is refused', async () => {
    expect(await resolveCaller('tok-gbrain_cl_stranger', fakeWhoami().deps))
      .toEqual({ ok: false, status: 403, error: 'unknown_client' });
  });

  test('a bad token is 401 invalid_token', async () => {
    expect(await resolveCaller('garbage-token-value', fakeWhoami().deps))
      .toEqual({ ok: false, status: 401, error: 'invalid_token' });
  });

  test('Review focus 3: ops down is 503 identity_unavailable, and is not cached', async () => {
    const clientId = await clientIdOf(fx.alice.privateConnectionId);
    const down = { whoami: async () => { throw new Error('ECONNREFUSED'); }, now: () => 0, ttlMs: 30_000 };
    expect(await resolveCaller(`tok-${clientId}`, down))
      .toEqual({ ok: false, status: 503, error: 'identity_unavailable' });
    const up = fakeWhoami();
    expect((await resolveCaller(`tok-${clientId}`, up.deps)).ok).toBe(true);
    expect(up.calls.length).toBe(1);
  });

  test('a gbrain 502 is 503 identity_unavailable, not a bad token', async () => {
    const flaky = { whoami: async () => ({ ok: false as const, status: 502 as const, error: 'gbrain_http_500' }), now: () => 0, ttlMs: 0 };
    expect(await resolveCaller('tok-anything', flaky))
      .toEqual({ ok: false, status: 503, error: 'identity_unavailable' });
  });

  test('whoami is cached per token for the TTL, then asked again', async () => {
    const clientId = await clientIdOf(fx.admin.privateConnectionId);
    const w = fakeWhoami();
    await resolveCaller(`tok-${clientId}`, w.deps);
    await resolveCaller(`tok-${clientId}`, w.deps);
    expect(w.calls.length).toBe(1);
    w.advance(30_001);
    await resolveCaller(`tok-${clientId}`, w.deps);
    expect(w.calls.length).toBe(2);
  });

  test('Review focus 2: a revoke inside the cache TTL is refused on the very next call', async () => {
    const clientId = await clientIdOf(fx.bob.privateConnectionId);
    const w = fakeWhoami();
    expect((await resolveCaller(`tok-${clientId}`, w.deps)).ok).toBe(true);
    await getDb().update(schema.connections).set({ state: 'revoked', revokedAt: new Date() })
      .where(eq(schema.connections.id, fx.bob.privateConnectionId));
    const again = await resolveCaller(`tok-${clientId}`, w.deps);
    expect(w.calls.length).toBe(1);
    expect(again.ok === false && again.error).toBe('connection_inactive');
  });

  test('a demotion takes effect on the next call', async () => {
    const clientId = await clientIdOf(fx.admin.privateConnectionId);
    const w = fakeWhoami();
    await resolveCaller(`tok-${clientId}`, w.deps);
    await getDb().update(schema.memberships).set({ role: 'member' })
      .where(eq(schema.memberships.id, fx.admin.membershipId));
    const r = await resolveCaller(`tok-${clientId}`, w.deps);
    expect(r.ok && r.caller.role).toBe('member');
    await getDb().update(schema.memberships).set({ role: 'admin' })
      .where(eq(schema.memberships.id, fx.admin.membershipId));
  });

  test('a data-only Connection is refused with control_disabled', async () => {
    const clientId = await clientIdOf(fx.owner.privateConnectionId);
    await getDb().update(schema.connections).set({ controlEnabled: false })
      .where(eq(schema.connections.id, fx.owner.privateConnectionId));
    try {
      const r = await resolveCaller(`tok-${clientId}`, fakeWhoami().deps);
      expect(r).toEqual({ ok: false, status: 403, error: 'control_disabled',
        audit: { orgId: fx.orgId, actor: fx.owner.userId, clientId } });
    } finally {
      await getDb().update(schema.connections).set({ controlEnabled: true })
        .where(eq(schema.connections.id, fx.owner.privateConnectionId));
    }
  });

  test('the TTL env is clamped to 60 s', async () => {
    process.env.CONTROL_MCP_IDENTITY_TTL_MS = '600000';
    const { defaultResolverDeps } = await import('../../src/control/mcp/caller.ts');
    expect(defaultResolverDeps().ttlMs).toBe(60_000);
    delete process.env.CONTROL_MCP_IDENTITY_TTL_MS;
  });
});
