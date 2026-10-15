// test/db/routes-schema.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';
import type { McpCaller } from '../../src/server/gbrain/mcp.ts';

let w: TestWorld; let ownerKey: string;
const calls: string[] = [];
beforeAll(async () => {
  w = await world({
    mcp: () => (async (tool: string) => {
      calls.push(tool);
      if (tool === 'schema_stats') return { types: [{ type: 'person', count: 7 }] };
      if (tool === 'schema_review_orphans') return { pages: [{ slug: 'misc/x' }] };
      if (tool === 'run_doctor') return { ok: true, checks: [] };
      if (tool === 'get_stats') return { pages: 12 };
      return {};
    }) as McpCaller,
  });
  ({ apiKey: ownerKey } = await new PeopleService(w.deps).bootstrapOwner({ email: 'own@x.io' }));
});
afterAll(async () => w.drop());

test('GET /api/schema returns layers, typed counts, orphans and the lock', async () => {
  const r = await (await w.req('/api/schema', { as: ownerKey })).json();
  expect(r.active).toBe('mobrain-brain');
  expect(r.coreLock.ok).toBe(true);
  expect(r.types.find((t: { name: string }) => t.name === 'person').count).toBe(7);
  expect(r.orphans).toEqual([{ slug: 'misc/x' }]);
});

test('GET /api/schema needs a login', async () => {
  expect((await w.req('/api/schema')).status).toBe(401);
});

test('GET /api/admin/health is owner/admin only and includes doctor, stats, autopilot and the lock', async () => {
  const r = await (await w.req('/api/admin/health', { as: ownerKey })).json();
  expect(r).toMatchObject({ coreLock: { ok: true }, doctor: { ok: true }, stats: { pages: 12 }, autopilot: { status: 'fresh' } });
  expect(r.pin.matches).toBe(true);
});
