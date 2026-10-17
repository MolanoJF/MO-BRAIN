import { Hono } from 'hono';
import type { Deps } from '../app.ts';
import { parseCollector, type CollectorConfig } from '../collectors/model.ts';
import { collectorMarkdown, collectorSlug, putPageArgv } from '../collectors/pages.ts';
import { CollectorService, PREFIX } from '../collectors/service.ts';
import { assertOk } from '../gbrain/cli.ts';
import { McpError } from '../gbrain/mcp.ts';
import { getPage, type Page } from '../gbrain/pages.ts';
import { PeopleService } from '../people/service.ts';
import { HttpError, jsonBody, requireUser, type AppEnv } from '../http.ts';

// TSV: slug, source, kind, allowed_tools (comma), model, timeout_s, mode. No jq on the host.
function dueTsv(rows: { config: CollectorConfig; mode: 'backfill' | 'incremental' }[]): string {
  const lines = rows.map(({ config: k, mode }) =>
    [k.slug, k.source, k.kind, k.allowedTools.join(','), k.model ?? '', String(k.timeoutS), mode].join('\t'));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export function runnerRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const svc = new CollectorService(deps);
  const people = new PeopleService(deps);

  async function writePage(source: string, slug: string, fm: Record<string, unknown>, notes: string) {
    const parsed = parseCollector(slug, source, { type: 'collector', ...fm });
    if (!parsed.ok) throw new HttpError(400, 'invalid_collector', parsed.errors);
    const { config } = parsed;
    // The page must be the object that was validated. parseCollector filters and
    // defaults these three, so taking them from the raw body would put e.g.
    // `allowed_tools: [t, 42]` and `backfill_days: abc` on the page.
    const page: Record<string, unknown> = { ...fm, allowed_tools: config.allowedTools, backfill_days: config.backfillDays };
    if (config.model) page.model = config.model; else delete page.model;
    assertOk('gbrain put', await deps.cli(putPageArgv(slug, source), { timeoutMs: 30_000, stdin: collectorMarkdown(page, notes) }));
  }

  r.get('/api/runner/due', async (c) => {
    const user = requireUser(c);
    const slug = c.req.query('slug');
    if (slug) {
      const one = await svc.one(user, slug);
      if (!one) throw new HttpError(404, 'collector_not_found');
      return c.text(dueTsv([one]));
    }
    return c.text(dueTsv(await svc.due(user)));
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

  r.post('/api/collectors', async (c) => {
    const user = requireUser(c);
    const b = await jsonBody<{ title?: string; kind?: string; cadence?: string; allowedTools?: string[]; model?: string;
      backfillDays?: number; source?: string; notes?: string; toolHint?: string }>(c);
    if (!b.title) throw new HttpError(400, 'title_required');
    // A non-string title reaches slugFor's text.includes and a non-string notes
    // reaches notes.trim(); both are client errors, not 500s. A nullish notes
    // still means "no notes" (it is coalesced to ''), so only reject the rest.
    if (typeof b.title !== 'string') throw new HttpError(400, 'invalid_collector', ['title']);
    if (b.notes != null && typeof b.notes !== 'string') throw new HttpError(400, 'invalid_collector', ['notes']);
    const mine = await svc.runnableSources(user);
    const source = b.source ?? mine.find((s) => s.startsWith('p-'));
    if (!source || !mine.includes(source)) throw new HttpError(403, 'not_your_source');
    const slug = collectorSlug(b.title);
    const fm: Record<string, unknown> = {
      title: b.title, kind: b.kind, enabled: true, cadence: b.cadence, harness: 'claude-code',
      allowed_tools: b.allowedTools ?? [], target_source: source, backfill_days: b.backfillDays ?? 90,
    };
    if (b.model) fm.model = b.model;
    if (b.toolHint) fm.tool_hint = b.toolHint;
    await writePage(source, slug, fm, b.notes ?? '');
    return c.json({ slug, source });
  });

  r.patch('/api/collectors/:source/*', async (c) => {
    const user = requireUser(c);
    const source = c.req.param('source');
    if (!(await svc.runnableSources(user)).includes(source)) throw new HttpError(403, 'not_your_source');
    const slug = c.req.path.slice(`/api/collectors/${source}/`.length);
    if (!slug.startsWith(PREFIX)) throw new HttpError(404, 'collector_not_found');
    const b = await jsonBody<{ enabled?: boolean; cadence?: string }>(c);
    let page: Page;
    try {
      page = await getPage(deps.mcp(await people.uiToken(user)), source, slug);
    } catch (e) {
      // A page gbrain does not have is a 404, not an internal failure (same as
      // GET /api/pages/:source/* in brain.ts).
      if (e instanceof McpError && e.code === 'page_not_found') throw new HttpError(404, 'collector_not_found');
      throw e;
    }
    // Only a collector page may be edited here; anything else at this slug is not ours.
    if (page.frontmatter.type !== 'collector') throw new HttpError(404, 'collector_not_found');
    const { type: _t, ...fm } = page.frontmatter;
    if (typeof b.enabled === 'boolean') fm.enabled = b.enabled;
    if (b.cadence) fm.cadence = b.cadence;
    await writePage(source, slug, fm, page.body);
    return c.json({ ok: true });
  });

  return r;
}
