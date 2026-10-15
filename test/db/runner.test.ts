// test/db/runner.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';
import type { McpCaller } from '../../src/server/gbrain/mcp.ts';

const page = (cadence: string, extra = '') =>
  `---\ntype: collector\ntitle: Mail\nkind: email\nenabled: true\ncadence: ${cadence}\nallowed_tools:\n  - mcp__gmail__*\ntarget_source: p-own\n${extra}---\nbody`;

let w: TestWorld; let key: string;
beforeAll(async () => {
  w = await world({
    mcp: () => (async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'list_pages') return { pages: [
        { slug: 'system/collectors/mail', source_id: 'p-own' },
        { slug: 'system/collectors/broken', source_id: 'p-own' },
        { slug: 'system/collectors/theirs', source_id: 'c-company' },
      ] };
      if (tool === 'get_page' && args.slug === 'system/collectors/mail') return { slug: args.slug, source_id: 'p-own', content: page('2h') };
      if (tool === 'get_page' && args.slug === 'system/collectors/broken') return { slug: args.slug, source_id: 'p-own', content: page('5m') };
      return { slug: args.slug, source_id: 'c-company', content: page('2h').replace('p-own', 'c-company') };
    }) as McpCaller,
  });
  ({ apiKey: key } = await new PeopleService(w.deps).bootstrapOwner({ email: 'own@x.io' }));
});
afterAll(async () => w.drop());

const post = (p: string, b: unknown) => w.req(p, { method: 'POST', body: JSON.stringify(b), as: key });

describe('runner', () => {
  test('due lists only my valid collectors, as TSV, in backfill mode before the first ok run', async () => {
    const text = await (await w.req('/api/runner/due', { as: key })).text();
    expect(text.trim().split('\n')).toEqual(['system/collectors/mail\tp-own\temail\tmcp__gmail__*\t\t1200\tbackfill']);
  });

  test('start, finish, then not due until the cadence elapses', async () => {
    const { runId } = await (await post('/api/runner/start', { slug: 'system/collectors/mail', source: 'p-own' })).json();
    expect((await post('/api/runner/start', { slug: 'system/collectors/mail', source: 'p-own' })).status).toBe(409);
    expect((await w.req('/api/runner/due', { as: key })).status).toBe(200);
    expect((await (await w.req('/api/runner/due', { as: key })).text()).trim()).toBe('');
    await post('/api/runner/finish', { runId, status: 'ok', exitCode: 0, summary: 'read 3, wrote 2', logTail: 'x'.repeat(10_000) });
    const [row] = await w.sql`select status, length(log_tail)::int as n, summary from collector_runs where id = ${runId}`;
    expect(row).toMatchObject({ status: 'ok', n: 4096, summary: 'read 3, wrote 2' });
    expect((await (await w.req('/api/runner/due', { as: key })).text()).trim()).toBe('');
    w.setNow(new Date(w.deps.now().getTime() + 3 * 3600_000));
    expect((await (await w.req('/api/runner/due', { as: key })).text())).toContain('\tincremental');
  });

  test('a finish for someone else\'s run is refused', async () => {
    const [other] = await w.sql`insert into users (email, role, status) values ('x@x.io', 'member', 'active') returning id`;
    const [run] = await w.sql`insert into collector_runs (user_id, source_id, collector, status) values (${other!.id}, 'p-x', 's', 'running') returning id`;
    expect((await post('/api/runner/finish', { runId: run!.id, status: 'ok', exitCode: 0 })).status).toBe(404);
  });

  test('the collectors view merges config, validation errors, last run and next due', async () => {
    const r = await (await w.req('/api/sources/p-own/collectors', { as: key })).json();
    const mail = r.collectors.find((c: { slug: string }) => c.slug === 'system/collectors/mail');
    expect(mail).toMatchObject({ kind: 'email', cadence: '2h', lastRun: { status: 'ok' } });
    expect(typeof mail.nextDue).toBe('string');
    expect(r.collectors.find((c: { slug: string }) => c.slug === 'system/collectors/broken').errors).toEqual(['cadence']);
  });
});
