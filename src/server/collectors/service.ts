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
