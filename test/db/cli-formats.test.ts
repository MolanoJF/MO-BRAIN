// test/db/cli-formats.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { runAdminCli } from '../../src/server/admin-cli.ts';
import type { McpCaller } from '../../src/server/gbrain/mcp.ts';

let w: TestWorld; let key: string;
beforeAll(async () => {
  w = await world({
    mcp: () => (async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'list_pages') return { pages: [{ slug: 'system/collectors/mail', source_id: 'p-own' }] };
      if (tool === 'get_page') return { slug: args.slug, source_id: 'p-own',
        content: '---\ntype: collector\nkind: email\ncadence: 2h\nallowed_tools: [mcp__g__*]\ntarget_source: p-own\n---\n' };
      return {};
    }) as McpCaller,
  });
  const out = await runAdminCli(['bootstrap', '--email', 'own@x.io', '--format', 'env'], w.deps);
  expect(out).toMatch(/^MOBRAIN_USER_ID=.+\nMOBRAIN_API_KEY=mbk_.+\nMOBRAIN_OWNER_PASSWORD=.+$/);
  key = /MOBRAIN_API_KEY=(.+)/.exec(out)![1]!;
});
afterAll(async () => w.drop());

test('people tsv', async () => {
  const t = await (await w.req('/api/people?format=tsv', { as: key })).text();
  expect(t).toMatch(/^[0-9a-f-]{36}\town@x\.io\towner\tactive\n$/);
});

test('client issue env and clients tsv with days left', async () => {
  const e = await (await w.req('/api/clients/issue?format=env', { method: 'POST', body: '{"purpose":"agent"}', as: key })).text();
  expect(e).toMatch(/^token=tok-.+\nmcp_url=http:\/\/127\.0\.0\.1:8787\/mcp\nname=gbrain\nexpires_at=.+\n$/);
  const t = await (await w.req('/api/clients/me?format=tsv', { as: key })).text();
  expect(t.split('\n').filter(Boolean).map((l) => l.split('\t')[0]).sort()).toEqual(['agent', 'ui']);
  expect(t).toMatch(/agent\tp-own\t\S+\t90\n/);
});

test('due?slug returns that collector even when not due', async () => {
  await w.req('/api/runner/start', { method: 'POST', body: '{"slug":"system/collectors/mail","source":"p-own"}', as: key });
  const t = await (await w.req('/api/runner/due?slug=system/collectors/mail', { as: key })).text();
  expect(t).toBe('system/collectors/mail\tp-own\temail\tmcp__g__*\t\t1200\tbackfill\n');
});
