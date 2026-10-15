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
