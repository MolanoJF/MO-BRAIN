import { Hono } from 'hono';
import type { Deps } from '../app.ts';
import type { CollectorConfig } from '../collectors/model.ts';
import { CollectorService } from '../collectors/service.ts';
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

  return r;
}
