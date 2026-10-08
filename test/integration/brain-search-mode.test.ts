import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

const ops = installOpsMock();

const { getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { buildZoneFixture, hit } = await import('../helpers/zoneFixture.ts');
const { eq } = await import('drizzle-orm');

pinDb();
let fx: Awaited<ReturnType<typeof buildZoneFixture>>;

const brain = async () => (await getDb().select().from(schema.brains))[0]!;
const setBrain = async (patch: Record<string, unknown>) => {
  await getDb().update(schema.brains).set(patch).where(eq(schema.brains.id, (await brain()).id));
};

beforeAll(async () => { fx = await buildZoneFixture(); }, 90_000);
afterAll(async () => { await closeDb(); });
beforeEach(() => { ops.reset(); ops.setCallDecorator(null); });

describe('/api/brain/search-mode', () => {
  test('GET returns the mode, the modes and the lifecycle', async () => {
    await setBrain({ lifecycle: 'ready', searchMode: 'balanced' });
    const res = await hit('GET', '/api/brain/search-mode', fx.owner.cookie);
    expect(res.status).toBe(200);
    const body = await res.json() as { mode: string; modes: { id: string }[]; lifecycle: string };
    expect(body.mode).toBe('balanced');
    expect(body.lifecycle).toBe('ready');
    expect(body.modes.map((m) => m.id)).toEqual(['conservative', 'balanced', 'tokenmax']);
  });

  test('PATCH on a ready brain runs config.set and stores the mode', async () => {
    await setBrain({ lifecycle: 'ready', searchMode: 'balanced' });
    const res = await hit('PATCH', '/api/brain/search-mode', fx.owner.cookie, { mode: 'conservative' });
    expect(res.status).toBe(200);
    expect(ops.calls.filter((c) => c.op === 'config.set').map((c) => c.params))
      .toEqual([{ key: 'search.mode', value: 'conservative' }]);
    expect((await brain()).searchMode).toBe('conservative');
    const audits = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'brain.searchMode'));
    expect(audits.length).toBeGreaterThan(0);
  });

  test('a failing config.set is a 502 and stores nothing', async () => {
    await setBrain({ lifecycle: 'ready', searchMode: 'balanced' });
    ops.setCallDecorator((op, r) => (op === 'config.set' ? { ...r, ok: false, exitCode: 1 } : r));
    const res = await hit('PATCH', '/api/brain/search-mode', fx.owner.cookie, { mode: 'tokenmax' });
    expect(res.status).toBe(502);
    expect((await brain()).searchMode).toBe('balanced');
  });

  test('before ready it only stores the mode', async () => {
    await setBrain({ lifecycle: 'sources-added', searchMode: 'balanced' });
    const res = await hit('PATCH', '/api/brain/search-mode', fx.owner.cookie, { mode: 'tokenmax' });
    expect(res.status).toBe(200);
    expect(ops.calls.some((c) => c.op === 'config.set')).toBe(false);
    expect((await brain()).searchMode).toBe('tokenmax');
  });

  test('an unknown mode is 400', async () => {
    const res = await hit('PATCH', '/api/brain/search-mode', fx.owner.cookie, { mode: 'turbo' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_mode');
  });

  test('a non-admin is 403 on both verbs', async () => {
    expect((await hit('GET', '/api/brain/search-mode', fx.alice.cookie)).status).toBe(403);
    expect((await hit('PATCH', '/api/brain/search-mode', fx.alice.cookie, { mode: 'balanced' })).status).toBe(403);
  });
});
