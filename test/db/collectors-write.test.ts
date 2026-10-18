import { afterAll, beforeAll, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';
import { frontmatterOf } from '../../src/server/gbrain/pages.ts';
import type { CliResult } from '../../src/server/gbrain/cli.ts';
import { McpError, type McpCaller } from '../../src/server/gbrain/mcp.ts';

const writes: { argv: string[]; stdin?: string }[] = [];
let w: TestWorld; let key: string;
beforeAll(async () => {
  w = await world({
    cli: async (argv: string[], opts?: { stdin?: string }): Promise<CliResult> => {
      if (argv[0] === 'put') writes.push({ argv, stdin: opts?.stdin });
      if (argv[0] === '--version') return { exitCode: 0, stdout: 'gbrain 0.60.230.0', stderr: '' };
      return { exitCode: 0, stdout: '{}', stderr: '' };
    },
    mcp: () => (async (tool: string, args: Record<string, unknown>) => {
      if (tool !== 'get_page') return {};
      const slug = String(args.slug);
      if (slug === 'system/collectors/gone') throw new McpError('get_page: page_not_found', 422, 'get_page', 'page_not_found');
      if (slug === 'system/collectors/person') return { slug, source_id: 'p-own', content: '---\ntype: person\ntitle: Ada\n---\nabout ada' };
      return { slug, source_id: 'p-own', content: '---\ntype: collector\ntitle: Mail\nkind: email\nenabled: true\ncadence: 2h\nallowed_tools: [t]\ntarget_source: p-own\n---\nnotes' };
    }) as McpCaller,
  });
  ({ apiKey: key } = await new PeopleService(w.deps).bootstrapOwner({ email: 'own@x.io' }));
});
afterAll(async () => w.drop());

test('creating a collector validates it and writes the page into my private source', async () => {
  const r = await w.req('/api/collectors', { method: 'POST', as: key, body: JSON.stringify({
    title: 'Mail', kind: 'email', cadence: '2h', allowedTools: ['mcp__claude_ai_Gmail__*'], notes: 'Skip newsletters.' }) });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ slug: 'system/collectors/mail', source: 'p-own' });
  expect(writes[0]!.argv).toEqual(['put', 'system/collectors/mail', '--source', 'p-own', '--force']);
  expect(writes[0]!.stdin).toContain('target_source: p-own');
});

test('an invalid collector is refused with its errors', async () => {
  const r = await w.req('/api/collectors', { method: 'POST', as: key, body: JSON.stringify({ title: 'X', kind: 'fax', cadence: '1m', allowedTools: [] }) });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: 'invalid_collector', detail: ['kind', 'cadence', 'allowed_tools'] });
});

test('a source I cannot write is refused', async () => {
  const r = await w.req('/api/collectors', { method: 'POST', as: key, body: JSON.stringify({ title: 'X', kind: 'email', cadence: '2h', allowedTools: ['t'], source: 'c-nope' }) });
  expect(r.status).toBe(403);
});

test('patch pauses a collector, keeping its notes', async () => {
  const r = await w.req('/api/collectors/p-own/system/collectors/mail', { method: 'PATCH', as: key, body: JSON.stringify({ enabled: false }) });
  expect(r.status).toBe(200);
  const last = writes.at(-1)!;
  expect(last.stdin).toContain('enabled: false');
  expect(last.stdin).toContain('notes');
});

test('the written page carries the validated tools and days, not the raw body', async () => {
  const r = await w.req('/api/collectors', { method: 'POST', as: key, body: JSON.stringify({
    title: 'Mail', kind: 'email', cadence: '2h', allowedTools: ['t', 42], backfillDays: 'abc', notes: 'x' }) });
  expect(r.status).toBe(200);
  const { frontmatter } = frontmatterOf(writes.at(-1)!.stdin!);
  expect(frontmatter.allowed_tools).toEqual(['t']);
  expect(frontmatter.backfill_days).toBe(90);
});

test('a patch to a slug outside the collector prefix is 404', async () => {
  const r = await w.req('/api/collectors/p-own/people/ada', { method: 'PATCH', as: key, body: JSON.stringify({ enabled: false }) });
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ error: 'collector_not_found' });
});

test('a patch to a page that is not a collector is 404', async () => {
  const r = await w.req('/api/collectors/p-own/system/collectors/person', { method: 'PATCH', as: key, body: JSON.stringify({ enabled: false }) });
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ error: 'collector_not_found' });
});

test('a patch to a missing page is 404, not 500', async () => {
  const r = await w.req('/api/collectors/p-own/system/collectors/gone', { method: 'PATCH', as: key, body: JSON.stringify({ enabled: false }) });
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ error: 'collector_not_found' });
});

test('a non-string title is 400', async () => {
  const r = await w.req('/api/collectors', { method: 'POST', as: key, body: JSON.stringify({ title: 123, kind: 'email', cadence: '2h', allowedTools: ['t'] }) });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: 'invalid_collector', detail: ['title'] });
});

test('non-string notes are 400', async () => {
  const r = await w.req('/api/collectors', { method: 'POST', as: key, body: JSON.stringify({ title: 'Mail', kind: 'email', cadence: '2h', allowedTools: ['t'], notes: 42 }) });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: 'invalid_collector', detail: ['notes'] });
});
