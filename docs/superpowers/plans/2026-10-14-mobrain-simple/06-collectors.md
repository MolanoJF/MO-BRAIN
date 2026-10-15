# Phase 6: Collectors, pages, sources, activity

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Read `00-master.md` first.

**Goal:** The server side of collectors (spec §8.1–8.3): cadence parsing, collector page validation, due computation including stale runs, and the runner API; plus the read routes the UI needs for pages, sources and activity (§9.1, §9.2).

**Spec sections:** §8, §9.

---

### Task 6.1: gbrain argument names in one place

**Files:**
- Create: `src/server/gbrain/pages.ts`
- Test: `test/unit/gbrain-pages.test.ts`

Probe P7 recorded the real argument and field names of `list_pages` and `get_page`. They live only in this file. `list_pages` has no working `prefix` filter; `source_id` filters; the schema has `offset`. One `limit` page is not the source: page with `offset` until a short page, then apply a slug prefix locally. Items have no frontmatter object. `get_page` with `include_content: true` returns `content` and `frontmatter`. A client cannot read its own write unless the write source is included in federated read (`source_id` outside the grant is `permission_denied`). `search` argument names were not in the P7 tools list; this file does not invent one.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/gbrain-pages.test.ts
import { describe, expect, test } from 'bun:test';
import { frontmatterOf, getPage, listPages, searchPages } from '../../src/server/gbrain/pages.ts';
import type { McpCaller } from '../../src/server/gbrain/mcp.ts';

function recorder(reply: unknown) {
  const calls: [string, Record<string, unknown>][] = [];
  const call = (async (tool: string, args: Record<string, unknown>) => { calls.push([tool, args]); return reply; }) as McpCaller;
  return { calls, call };
}

describe('gbrain page helpers', () => {
  test('listPages filters with source_id and applies prefix locally', async () => {
    const { calls, call } = recorder({ pages: [
      { slug: 'a/b', source_id: 'p-x', title: 'B', type: 'note', updated_at: 't', updated_at_iso: 't' },
      { slug: 'notes/x', source_id: 'p-x', title: 'X', type: 'note' },
    ] });
    const rows = await listPages(call, { prefix: 'a/', source: 'p-x', limit: 10 });
    expect(calls).toEqual([['list_pages', { source_id: 'p-x', limit: 10, offset: 0 }]]);
    expect(rows).toEqual([{ slug: 'a/b', source: 'p-x', title: 'B', type: 'note', frontmatter: null }]);
  });

  test('listPages pages offset until a short page, then keeps the prefix', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const call = (async (_tool: string, args: Record<string, unknown>) => {
      calls.push(['list_pages', args]);
      if (args.offset === 0) return { pages: [
        { slug: 'notes/0', source_id: 'p-x', title: '0', type: 'note' },
        { slug: 'notes/1', source_id: 'p-x', title: '1', type: 'note' },
      ] };
      return { pages: [{ slug: 'system/collectors/mail', source_id: 'p-x', title: 'Mail', type: 'collector' }] };
    }) as McpCaller;
    const rows = await listPages(call, { prefix: 'system/collectors/', source: 'p-x', limit: 2 });
    expect(calls.map((c) => c[1].offset)).toEqual([0, 2]);
    expect(rows.map((r) => r.slug)).toEqual(['system/collectors/mail']);
  });

  test('getPage asks for include_content and source_id, and prefers the frontmatter object', async () => {
    const { calls, call } = recorder({
      slug: 's', source_id: 'p-x', type: 'collector',
      content: '---\ntype: collector\nkind: fixture\n---\nbody',
      frontmatter: { kind: 'fixture', cadence: '2h' },
    });
    const p = await getPage(call, 'p-x', 's');
    expect(calls[0]).toEqual(['get_page', { slug: 's', include_content: true, source_id: 'p-x' }]);
    expect(p.frontmatter).toEqual({ kind: 'fixture', cadence: '2h' });
    expect(p.body.trim()).toBe('body');
  });

  test('getPage reads frontmatter from content when the reply has none', async () => {
    const { call } = recorder({ slug: 's', source_id: 'p-x', content: '---\ntype: collector\ncadence: 2h\n---\nbody' });
    const p = await getPage(call, 'p-x', 's');
    expect(p.frontmatter).toEqual({ type: 'collector', cadence: '2h' });
    expect(p.body.trim()).toBe('body');
  });

  test('searchPages maps hits', async () => {
    const { calls, call } = recorder({ results: [{ slug: 'x', source_id: 'c-a', title: 'X', snippet: '…' }] });
    expect(await searchPages(call, 'zebra', 'c-a')).toEqual([{ slug: 'x', source: 'c-a', title: 'X', snippet: '…' }]);
    expect(calls[0]).toEqual(['search', { query: 'zebra', source: 'c-a', limit: 30 }]);
  });

  test('frontmatterOf tolerates a page without a fence', () => {
    expect(frontmatterOf('just text')).toEqual({ frontmatter: {}, body: 'just text' });
  });
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Write `src/server/gbrain/pages.ts`**

```ts
import { parse } from 'yaml';
import type { McpCaller } from './mcp.ts';

// Argument and field names, as recorded by probe P7. Change them here only.
// list_pages/get_page filter is source_id. prefix is ignored by gbrain. search's source name was not recorded.
const A = { sourceId: 'source_id', limit: 'limit', offset: 'offset', slug: 'slug', includeContent: 'include_content', query: 'query', searchSource: 'source' };
const rowSource = (r: Record<string, unknown>) => (r.source_id ?? r.source ?? r.sourceId ?? null) as string | null;

export type PageRow = { slug: string; source: string | null; title: string | null; type: string | null; frontmatter: Record<string, unknown> | null };
export type Page = { slug: string; source: string | null; frontmatter: Record<string, unknown>; body: string; raw: Record<string, unknown> };
export type Hit = { slug: string; source: string | null; title: string | null; snippet: string | null };

export function frontmatterOf(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!m) return { frontmatter: {}, body: content };
  try { return { frontmatter: (parse(m[1]!) ?? {}) as Record<string, unknown>, body: m[2]! }; }
  catch { return { frontmatter: {}, body: content }; }
}

function rows(reply: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(reply)) return reply as Record<string, unknown>[];
  const r = reply as Record<string, unknown>;
  return (r?.[key] ?? r?.items ?? []) as Record<string, unknown>[];
}

const PAGE = 200;

/** One source, every page. `limit` is the page size. Probe P7: `prefix` is ignored; stop when a page is short. */
export async function listPages(call: McpCaller, q: { prefix?: string; source: string; limit?: number }): Promise<PageRow[]> {
  const limit = q.limit ?? PAGE;
  const listed: PageRow[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = rows(await call('list_pages', { [A.sourceId]: q.source, [A.limit]: limit, [A.offset]: offset }), 'pages').map((r) => ({
      slug: String(r.slug),
      source: rowSource(r),
      title: (r.title as string) ?? null,
      type: (r.type ?? null) as string | null,
      frontmatter: null,
    }));
    listed.push(...page);
    if (page.length < limit) break;
  }
  return q.prefix ? listed.filter((row) => row.slug.startsWith(q.prefix)) : listed;
}

export async function getPage(call: McpCaller, source: string | null, slug: string): Promise<Page> {
  const args: Record<string, unknown> = { [A.slug]: slug, [A.includeContent]: true };
  if (source) args[A.sourceId] = source;
  const r = (await call('get_page', args)) as Record<string, unknown>;
  const content = String(r.content ?? r.compiled_truth ?? '');
  const parsed = frontmatterOf(content);
  const fm = (r.frontmatter && typeof r.frontmatter === 'object') ? r.frontmatter as Record<string, unknown> : parsed.frontmatter;
  return { slug, source: rowSource(r) ?? source, frontmatter: fm, body: parsed.body, raw: r };
}

export async function searchPages(call: McpCaller, query: string, source?: string): Promise<Hit[]> {
  const args: Record<string, unknown> = { [A.query]: query };
  if (source) args[A.searchSource] = source;
  args[A.limit] = 30;
  return rows(await call('search', args), 'results').map((r) => ({
    slug: String(r.slug), source: rowSource(r), title: (r.title as string) ?? null, snippet: (r.snippet ?? r.chunk_text ?? null) as string | null,
  }));
}
```

- [ ] **Step 3: Run** — Expected: PASS. **Commit:**

```bash
git add src/server/gbrain/pages.ts test/unit/gbrain-pages.test.ts
git commit -m "feat(server): gbrain page helpers with probe-recorded argument names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6.2: Cadence, collector validation, due computation

**Files:**
- Create: `src/server/collectors/model.ts`
- Test: `test/unit/collectors-model.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/collectors-model.test.ts
import { describe, expect, test } from 'bun:test';
import { isDue, nextDue, parseCadence, parseCollector, type LastRun } from '../../src/server/collectors/model.ts';

const H = 3600_000;
const now = new Date('2026-10-14T12:00:00Z');

describe('parseCadence', () => {
  test('accepts minutes, hours, days, daily@HH:MM and once', () => {
    expect(parseCadence('30m')).toEqual({ kind: 'every', ms: 30 * 60_000 });
    expect(parseCadence('2h')).toEqual({ kind: 'every', ms: 2 * H });
    expect(parseCadence('1d')).toEqual({ kind: 'every', ms: 24 * H });
    expect(parseCadence('daily@07:30')).toEqual({ kind: 'daily', hour: 7, minute: 30 });
    expect(parseCadence('once')).toEqual({ kind: 'once' });
  });
  test('refuses under 15 minutes and garbage', () => {
    expect(parseCadence('10m')).toBeNull();
    expect(parseCadence('daily@25:00')).toBeNull();
    expect(parseCadence('weekly')).toBeNull();
  });
});

describe('parseCollector', () => {
  const fm = { type: 'collector', title: 'Mail', kind: 'email', enabled: true, cadence: '2h', harness: 'claude-code', allowed_tools: ['mcp__gmail__*'], target_source: 'p-ada', backfill_days: 90 };
  test('accepts a valid page', () => {
    const r = parseCollector('system/collectors/mail', 'p-ada', fm);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config).toMatchObject({ slug: 'system/collectors/mail', source: 'p-ada', kind: 'email', timeoutS: 1200 });
  });
  test('lists every problem', () => {
    const r = parseCollector('system/collectors/x', 'p-ada', { ...fm, kind: 'fax', cadence: '5m', allowed_tools: [], target_source: 'p-other' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(['kind', 'cadence', 'allowed_tools', 'target_source']);
  });
  test('fixture collectors need no allowed tools', () => {
    expect(parseCollector('system/collectors/f', 'p-ada', { ...fm, kind: 'fixture', allowed_tools: [] }).ok).toBe(true);
  });
});

describe('isDue', () => {
  const cfg = (cadence: string, enabled = true) => {
    const r = parseCollector('s', 'p', { type: 'collector', kind: 'email', enabled, cadence, allowed_tools: ['t'], target_source: 'p' });
    if (!r.ok) throw new Error('bad'); return r.config;
  };
  const run = (over: Partial<LastRun>): LastRun => ({ startedAt: new Date(now.getTime() - H), finishedAt: new Date(now.getTime() - H), status: 'ok', timeoutS: 1200, ...over });

  test('never run is due; disabled is never due', () => {
    expect(isDue(cfg('2h'), null, now)).toBe(true);
    expect(isDue(cfg('2h', false), null, now)).toBe(false);
  });
  test('every: due once the cadence has elapsed since the last finish', () => {
    expect(isDue(cfg('2h'), run({}), now)).toBe(false);
    expect(isDue(cfg('30m'), run({}), now)).toBe(true);
  });
  test('a live running row is not due; a stale one is (Review Focus #3)', () => {
    expect(isDue(cfg('30m'), run({ status: 'running', finishedAt: null, startedAt: new Date(now.getTime() - 5 * 60_000) }), now)).toBe(false);
    expect(isDue(cfg('30m'), run({ status: 'running', finishedAt: null, startedAt: new Date(now.getTime() - 2 * H) }), now)).toBe(true);
  });
  test('daily: due after today\'s time when the last finish was before it', () => {
    expect(isDue(cfg('daily@07:00'), run({ finishedAt: new Date('2026-10-13T08:00:00Z') }), now)).toBe(true);
    expect(isDue(cfg('daily@07:00'), run({ finishedAt: new Date('2026-10-14T07:05:00Z') }), now)).toBe(false);
    expect(isDue(cfg('daily@13:00'), run({ finishedAt: new Date('2026-10-13T13:05:00Z') }), now)).toBe(false);
  });
  test('once: due only if it never finished ok', () => {
    expect(isDue(cfg('once'), run({}), now)).toBe(false);
    expect(isDue(cfg('once'), run({ status: 'error' }), now)).toBe(true);
  });
  test('nextDue for every is last finish + cadence', () => {
    expect(nextDue(cfg('2h'), run({}), now)!.toISOString()).toBe('2026-10-14T13:00:00.000Z');
  });
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Write `src/server/collectors/model.ts`**

```ts
export const KINDS = ['email', 'calendar', 'meetings', 'docs', 'notes-import', 'fixture'] as const;
export type Kind = (typeof KINDS)[number];
export type Cadence = { kind: 'every'; ms: number } | { kind: 'daily'; hour: number; minute: number } | { kind: 'once' };

export type CollectorConfig = {
  slug: string; source: string; title: string; kind: Kind; enabled: boolean; cadence: Cadence; cadenceText: string;
  harness: string; model: string | null; allowedTools: string[]; targetSource: string; backfillDays: number; timeoutS: number;
};

export type LastRun = { startedAt: Date; finishedAt: Date | null; status: 'running' | 'ok' | 'partial' | 'error' | 'timeout'; timeoutS: number };

const MIN_MS = 15 * 60_000;
const UNIT: Record<string, number> = { m: 60_000, h: 3600_000, d: 86400_000 };

export function parseCadence(text: unknown): Cadence | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === 'once') return { kind: 'once' };
  const every = /^(\d+)([mhd])$/.exec(t);
  if (every) {
    const ms = Number(every[1]) * UNIT[every[2]!]!;
    return ms >= MIN_MS ? { kind: 'every', ms } : null;
  }
  const daily = /^daily@(\d{2}):(\d{2})$/.exec(t);
  if (daily) {
    const hour = Number(daily[1]); const minute = Number(daily[2]);
    return hour < 24 && minute < 60 ? { kind: 'daily', hour, minute } : null;
  }
  return null;
}

export function parseCollector(slug: string, source: string, fm: Record<string, unknown>):
  { ok: true; config: CollectorConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const kind = fm.kind as Kind;
  if (!KINDS.includes(kind)) errors.push('kind');
  const cadence = parseCadence(fm.cadence);
  if (!cadence) errors.push('cadence');
  const tools = Array.isArray(fm.allowed_tools) ? fm.allowed_tools.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  if (kind !== 'fixture' && tools.length === 0) errors.push('allowed_tools');
  const target = typeof fm.target_source === 'string' ? fm.target_source : source;
  if (target !== source) errors.push('target_source');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: {
      slug, source, kind, cadence: cadence!, cadenceText: String(fm.cadence),
      title: typeof fm.title === 'string' ? fm.title : slug.split('/').pop()!,
      enabled: fm.enabled !== false,
      harness: typeof fm.harness === 'string' ? fm.harness : 'claude-code',
      model: typeof fm.model === 'string' ? fm.model : null,
      allowedTools: tools,
      targetSource: target,
      backfillDays: typeof fm.backfill_days === 'number' ? fm.backfill_days : 90,
      timeoutS: typeof fm.timeout_s === 'number' ? fm.timeout_s : 1200,
    },
  };
}

/** A running row past its timeout counts as finished (timeout) at start + timeout. */
function effectiveFinish(run: LastRun, now: Date): Date | null {
  if (run.status !== 'running') return run.finishedAt;
  const deadline = new Date(run.startedAt.getTime() + run.timeoutS * 1000);
  return deadline <= now ? deadline : null;
}

export function nextDue(c: CollectorConfig, last: LastRun | null, now: Date): Date | null {
  if (!c.enabled) return null;
  if (!last) return now;
  const finished = effectiveFinish(last, now);
  if (!finished) return null; // genuinely running
  if (c.cadence.kind === 'once') return last.status === 'ok' ? null : now;
  if (c.cadence.kind === 'every') return new Date(finished.getTime() + c.cadence.ms);
  const today = new Date(now); today.setHours(c.cadence.hour, c.cadence.minute, 0, 0);
  if (finished < today) return today;
  const tomorrow = new Date(today.getTime() + 86400_000);
  return tomorrow;
}

export function isDue(c: CollectorConfig, last: LastRun | null, now: Date): boolean {
  const n = nextDue(c, last, now);
  return n !== null && n <= now;
}
```

Daily times use the server's local time. The container gets `TZ` from `.env` (`bin/mobrain install` writes the host's zone). Tests pin `TZ=UTC`: change the two scripts in `package.json` to `"test:unit": "TZ=UTC bash scripts/test-isolated.sh test/unit && TZ=UTC bash scripts/test-isolated.sh test/unit/cli"` and `"test:db": "TZ=UTC bash scripts/test-db.sh"`.

- [ ] **Step 3: Run** — Expected: PASS. **Commit:**

```bash
git add src/server/collectors/model.ts test/unit/collectors-model.test.ts package.json
git commit -m "feat(collectors): cadence, page validation, due computation with stale runs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6.3: Collector service and runner routes

**Files:**
- Create: `src/server/collectors/service.ts`
- Create: `src/server/routes/runner.ts`
- Modify: `src/server/app.ts` (mount after schema)
- Test: `test/db/runner.test.ts`

Which collectors a person runs: those in their own private source, plus those in company sources for which they hold a live `company_writer` client. The server reads collector pages with the person's `ui` client (gbrain enforces what they can see).

- [ ] **Step 1: Write the failing test**

```ts
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
```

Run — Expected: FAIL.

- [ ] **Step 2: Write `src/server/collectors/service.ts`**

```ts
import type { Deps } from '../app.ts';
import { getPage, listPages } from '../gbrain/pages.ts';
import { scrub } from '../gbrain/cli.ts';
import { HttpError } from '../http.ts';
import { PeopleService } from '../people/service.ts';
import type { User } from '../types.ts';
import { isDue, nextDue, parseCollector, type CollectorConfig, type LastRun } from './model.ts';

export const PREFIX = 'system/collectors/';
const LOG_TAIL = 4096;

export type CollectorEntry =
  | { slug: string; source: string; ok: true; config: CollectorConfig }
  | { slug: string; source: string; ok: false; errors: string[] };

export class CollectorService {
  private people: PeopleService;
  constructor(private d: Deps) { this.people = new PeopleService(d); }

  /** Sources whose collectors this person runs: own private + company sources they hold a writer for. */
  async runnableSources(user: User): Promise<string[]> {
    const rows = await this.d.sql<{ id: string }[]>`
      select id from sources where owner_user_id = ${user.id} and status = 'active'
      union
      select write_source as id from gbrain_clients
      where user_id = ${user.id} and purpose = 'company_writer' and revoked_at is null`;
    return rows.map((r) => r.id);
  }

  async collectors(user: User, sources: string[]): Promise<CollectorEntry[]> {
    const call = this.d.mcp(await this.people.uiToken(user));
    const out: CollectorEntry[] = [];
    // Probe P7: prefix is not a filter and one limit page is not the source. List each runnable source.
    for (const source of sources) {
      for (const row of await listPages(call, { source, prefix: PREFIX })) {
        if (row.source !== source) continue;
        const fm = row.frontmatter ?? (await getPage(call, row.source, row.slug)).frontmatter;
        const parsed = parseCollector(row.slug, row.source, fm);
        out.push(parsed.ok ? { slug: row.slug, source: row.source, ok: true, config: parsed.config }
                           : { slug: row.slug, source: row.source, ok: false, errors: parsed.errors });
      }
    }
    return out;
  }

  async lastRuns(sources: string[]): Promise<Map<string, LastRun & { summary: string | null }>> {
    if (sources.length === 0) return new Map();
    const rows = await this.d.sql<(LastRun & { sourceId: string; collector: string; summary: string | null })[]>`
      select distinct on (source_id, collector) source_id, collector, started_at, finished_at, status, timeout_s, summary
      from collector_runs where source_id in ${this.d.sql(sources)}
      order by source_id, collector, started_at desc`;
    return new Map(rows.map((r) => [`${r.sourceId}|${r.collector}`, r]));
  }

  async due(user: User): Promise<{ config: CollectorConfig; mode: 'backfill' | 'incremental' }[]> {
    const sources = await this.runnableSources(user);
    const runs = await this.lastRuns(sources);
    const okBefore = new Set((await this.d.sql<{ k: string }[]>`
      select distinct source_id || '|' || collector as k from collector_runs where status = 'ok'`).map((r) => r.k));
    const now = this.d.now();
    return (await this.collectors(user, sources))
      .filter((e): e is Extract<CollectorEntry, { ok: true }> => e.ok)
      .filter((e) => isDue(e.config, runs.get(`${e.source}|${e.slug}`) ?? null, now))
      .map((e) => ({ config: e.config, mode: okBefore.has(`${e.source}|${e.slug}`) ? 'incremental' : 'backfill' }));
  }

  async start(user: User, slug: string, source: string, timeoutS: number): Promise<string> {
    if (!(await this.runnableSources(user)).includes(source)) throw new HttpError(403, 'not_your_source');
    const last = (await this.lastRuns([source])).get(`${source}|${slug}`);
    const now = this.d.now();
    if (last?.status === 'running' && last.startedAt.getTime() + last.timeoutS * 1000 > now.getTime()) {
      throw new HttpError(409, 'already_running');
    }
    const [row] = await this.d.sql<{ id: string }[]>`
      insert into collector_runs (user_id, source_id, collector, started_at, status, timeout_s)
      values (${user.id}, ${source}, ${slug}, ${now}, 'running', ${timeoutS}) returning id`;
    return row!.id;
  }

  async finish(user: User, runId: string, r: { status: string; exitCode: number | null; summary?: string; logTail?: string }): Promise<void> {
    if (!['ok', 'partial', 'error', 'timeout'].includes(r.status)) throw new HttpError(400, 'invalid_status');
    const tail = r.logTail ? scrub(r.logTail).slice(-LOG_TAIL) : null;
    const done = await this.d.sql`
      update collector_runs set finished_at = ${this.d.now()}, status = ${r.status}, exit_code = ${r.exitCode},
        summary = ${r.summary?.slice(0, 500) ?? null}, log_tail = ${tail}
      where id = ${runId} and user_id = ${user.id} returning id`;
    if (done.length === 0) throw new HttpError(404, 'run_not_found');
  }

  async view(user: User, source: string) {
    const entries = await this.collectors(user, [source]);
    const runs = await this.lastRuns([source]);
    const now = this.d.now();
    return entries.map((e) => {
      const last = runs.get(`${e.source}|${e.slug}`) ?? null;
      return e.ok
        ? { slug: e.slug, title: e.config.title, kind: e.config.kind, enabled: e.config.enabled, cadence: e.config.cadenceText,
            lastRun: last, nextDue: nextDue(e.config, last, now)?.toISOString() ?? null, errors: [] as string[] }
        : { slug: e.slug, title: e.slug, kind: null, enabled: false, cadence: null, lastRun: last, nextDue: null, errors: e.errors };
    });
  }
}
```

- [ ] **Step 3: Write `src/server/routes/runner.ts`**

```ts
import { Hono } from 'hono';
import type { Deps } from '../app.ts';
import { CollectorService } from '../collectors/service.ts';
import { HttpError, jsonBody, requireUser, type AppEnv } from '../http.ts';

export function runnerRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const svc = new CollectorService(deps);

  // TSV: slug, source, kind, allowed_tools (comma), model, timeout_s, mode. No jq on the host.
  r.get('/api/runner/due', async (c) => {
    const due = await svc.due(requireUser(c));
    const lines = due.map(({ config: k, mode }) =>
      [k.slug, k.source, k.kind, k.allowedTools.join(','), k.model ?? '', String(k.timeoutS), mode].join('\t'));
    return c.text(lines.length ? `${lines.join('\n')}\n` : '');
  });

  r.post('/api/runner/start', async (c) => {
    const { slug, source, timeoutS } = await jsonBody<{ slug?: string; source?: string; timeoutS?: number }>(c);
    if (!slug || !source) throw new HttpError(400, 'slug_and_source_required');
    return c.json({ runId: await svc.start(requireUser(c), slug, source, timeoutS ?? 1200) });
  });

  r.post('/api/runner/finish', async (c) => {
    const b = await jsonBody<{ runId?: string; status?: string; exitCode?: number; summary?: string; logTail?: string }>(c);
    if (!b.runId || !b.status) throw new HttpError(400, 'runId_and_status_required');
    await svc.finish(requireUser(c), b.runId, { status: b.status, exitCode: b.exitCode ?? null, summary: b.summary, logTail: b.logTail });
    return c.json({ ok: true });
  });

  r.get('/api/sources/:id/collectors', async (c) => c.json({ collectors: await svc.view(requireUser(c), c.req.param('id')) }));

  return r;
}
```

- [ ] **Step 4: Mount** — `app.route('/', runnerRoutes(deps));` after `schemaRoutes`.

- [ ] **Step 5: Run** — `bun run test:db` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/collectors src/server/routes/runner.ts src/server/app.ts test/db/runner.test.ts
git commit -m "feat(collectors): runner API (due, start, finish) and collectors view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6.4: Pages, sources and activity routes

**Files:**
- Create: `src/server/routes/brain.ts`
- Modify: `src/server/app.ts`
- Test: `test/db/routes-brain.test.ts`

Readable sources for a person are their `ui` spec's write source plus read sources; the server refuses any other `source` parameter before calling gbrain (and gbrain would refuse it anyway).

- [ ] **Step 1: Write the failing test**

```ts
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
```

Run — Expected: FAIL.

- [ ] **Step 2: Write `src/server/routes/brain.ts`**

```ts
import { Hono } from 'hono';
import type { Deps } from '../app.ts';
import { getPage, listPages, searchPages } from '../gbrain/pages.ts';
import { HttpError, requireRole, requireUser, type AppEnv } from '../http.ts';
import { compileUserClients } from '../people/compile.ts';
import { PeopleService } from '../people/service.ts';
import type { Source, User } from '../types.ts';

export function brainRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const people = new PeopleService(deps);

  async function readable(user: User): Promise<string[]> {
    const ui = compileUserClients(user, await people.state()).find((s) => s.purpose === 'ui');
    return ui ? [ui.writeSource, ...ui.readSources] : [];
  }

  async function guard(user: User, source: string | undefined): Promise<string> {
    if (!source) throw new HttpError(400, 'source_required');
    if (!(await readable(user)).includes(source)) throw new HttpError(403, 'source_not_readable');
    return source;
  }

  r.get('/api/sources', async (c) => {
    const user = requireUser(c);
    const ids = await readable(user);
    const rows = ids.length ? await deps.sql<Source[]>`select id, kind, owner_user_id, name, status from sources where id in ${deps.sql(ids)}` : [];
    const order = new Map(ids.map((id, i) => [id, i]));
    return c.json({ sources: rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!) });
  });

  r.get('/api/sources/:id/status', async (c) => {
    const user = requireUser(c);
    const id = await guard(user, c.req.param('id'));
    return c.json(await deps.mcp(await people.uiToken(user))('sources_status', { id }));
  });

  r.get('/api/pages', async (c) => {
    const user = requireUser(c);
    const source = await guard(user, c.req.query('source'));
    const call = deps.mcp(await people.uiToken(user));
    const q = c.req.query('q');
    if (q) return c.json({ hits: await searchPages(call, q, source) });
    // Same paging as listPages: source_id plus offset until a short page. prefix is local. Not one page of 500.
    return c.json({ pages: await listPages(call, { source, prefix: c.req.query('prefix') ?? undefined }) });
  });

  r.get('/api/pages/:source/*', async (c) => {
    const user = requireUser(c);
    const source = await guard(user, c.req.param('source'));
    const slug = c.req.path.slice(`/api/pages/${source}/`.length);
    if (!slug) throw new HttpError(400, 'slug_required');
    const p = await getPage(deps.mcp(await people.uiToken(user)), source, decodeURIComponent(slug));
    return c.json({ slug: p.slug, source: p.source, frontmatter: p.frontmatter, body: p.body });
  });

  r.get('/api/activity', requireRole('owner', 'admin'), async (c) => {
    const call = deps.mcp(await people.instanceToken());
    const jobsRaw = await call('list_jobs', { limit: 50 }).catch((e) => ({ error: String(e.message ?? e) }));
    const jobs = Array.isArray(jobsRaw) ? jobsRaw : ((jobsRaw as { jobs?: unknown[] }).jobs ?? jobsRaw);
    const runs = await deps.sql`
      select r.id, u.email, r.source_id, r.collector, r.started_at, r.finished_at, r.status, r.summary
      from collector_runs r join users u on u.id = r.user_id order by r.started_at desc limit 100`;
    const audit = await deps.sql`
      select a.at, u.email as actor, a.action, a.target from audit_log a left join users u on u.id = a.actor_user_id
      order by a.id desc limit 100`;
    return c.json({ jobs, runs, audit });
  });

  return r;
}
```

- [ ] **Step 3: Mount** — `app.route('/', brainRoutes(deps));` after `runnerRoutes`. The more specific `/api/sources/:id/collectors` (runner routes) is mounted first, so it wins over nothing here (no clash: `brain.ts` has `/api/sources/:id/status`).

- [ ] **Step 4: Run** — `bun run test:db` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/brain.ts src/server/app.ts test/db/routes-brain.test.ts
git commit -m "feat(server): pages, sources and activity read routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
