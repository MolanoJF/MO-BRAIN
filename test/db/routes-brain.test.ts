// test/db/routes-brain.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';
import type { McpCaller } from '../../src/server/gbrain/mcp.ts';

const calls: [string, Record<string, unknown>][] = [];
let w: TestWorld; let ownerKey: string; let memberKey: string;
beforeAll(async () => {
  w = await world({
    mcp: () => (async (tool: string, args: Record<string, unknown>) => {
      calls.push([tool, args]);
      if (tool === 'list_pages') return { pages: [{ slug: 'people/ada', source_id: 'p-own', title: 'Ada', type: 'person' }] };
      if (tool === 'get_page') return { slug: args.slug, source_id: 'p-own', content: '---\ntype: person\n---\n# Ada' };
      if (tool === 'search') return { results: [{ slug: 'people/ada', source_id: 'p-own', title: 'Ada', snippet: 'Ada' }] };
      if (tool === 'sources_status') return { ok: true };
      if (tool === 'list_jobs') return { jobs: [{ id: 1, name: 'sync', status: 'completed' }] };
      return {};
    }) as McpCaller,
  });
  const people = new PeopleService(w.deps);
  ({ apiKey: ownerKey } = await people.bootstrapOwner({ email: 'own@x.io' }));
  const owner = await people.userByEmail('own@x.io');
  await people.setMode(owner, 'company');
  const { claimUrl } = await people.invite(owner, 'm@x.io', 'member');
  ({ joinKey: memberKey } = await people.claim(claimUrl.split('/claim/')[1]!, 'member-password', null));
});
afterAll(async () => w.drop());

describe('brain read routes', () => {
  test('sources lists only what the caller can read', async () => {
    const own = await (await w.req('/api/sources', { as: ownerKey })).json();
    expect(own.sources.map((s: { id: string }) => s.id)).toEqual(['p-own', 'c-company']);
    const mem = await (await w.req('/api/sources', { as: memberKey })).json();
    expect(mem.sources.map((s: { id: string }) => s.id)).toEqual(['p-m']);
  });

  test('pages: list and search pass through; another source is refused before gbrain', async () => {
    expect((await (await w.req('/api/pages?source=p-own&prefix=people/', { as: ownerKey })).json()).pages[0].slug).toBe('people/ada');
    expect((await (await w.req('/api/pages?source=p-own&q=ada', { as: ownerKey })).json()).hits[0].slug).toBe('people/ada');
    const before = calls.length;
    expect((await w.req('/api/pages?source=p-own', { as: memberKey })).status).toBe(403);
    expect(calls.length).toBe(before);
  });

  test('a single page returns frontmatter and body', async () => {
    const p = await (await w.req('/api/pages/p-own/people/ada', { as: ownerKey })).json();
    expect(p).toMatchObject({ slug: 'people/ada', frontmatter: { type: 'person' } });
    expect(p.body).toContain('# Ada');
  });

  test('activity is owner/admin only', async () => {
    expect((await w.req('/api/activity', { as: memberKey })).status).toBe(403);
    const a = await (await w.req('/api/activity', { as: ownerKey })).json();
    expect(a.jobs).toEqual([{ id: 1, name: 'sync', status: 'completed' }]);
    expect(Array.isArray(a.runs)).toBe(true);
    expect(a.audit.length).toBeGreaterThan(0);
  });
});
