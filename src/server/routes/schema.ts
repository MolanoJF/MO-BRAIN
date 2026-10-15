import { Hono } from 'hono';
import type { Deps } from '../app.ts';
import { lastJson } from '../gbrain/cli.ts';
import { requireRole, requireUser, type AppEnv } from '../http.ts';
import { PeopleService } from '../people/service.ts';
import { buildSchemaView, readLockInput } from '../schema/service.ts';
import { checkCoreLock } from '../schema/coreLock.ts';

function statsMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const rows = (raw as { types?: { type?: string; name?: string; count?: number }[] })?.types ?? [];
  for (const r of rows) { const k = r.type ?? r.name; if (k && typeof r.count === 'number') out[k] = r.count; }
  return out;
}

function orphanList(raw: unknown): unknown[] {
  const o = raw as { pages?: unknown[]; orphans?: unknown[] } | unknown[];
  return Array.isArray(o) ? o : (o?.pages ?? o?.orphans ?? []);
}

export function schemaRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const people = new PeopleService(deps);
  const paths = () => ({ packsDir: deps.env.packsDir, gbrainHome: deps.env.gbrainHome, cli: deps.cli });

  r.get('/api/schema', async (c) => {
    const call = deps.mcp(await people.uiToken(requireUser(c)));
    const [stats, orphans] = await Promise.all([
      call('schema_stats', {}).then(statsMap, () => null),
      call('schema_review_orphans', { limit: 50 }).then(orphanList, () => null),
    ]);
    return c.json(await buildSchemaView({ ...paths(), stats, orphans }));
  });

  r.get('/api/admin/health', requireRole('owner', 'admin'), async (c) => {
    const call = deps.mcp(await people.instanceToken());
    const v = await deps.cli(['--version'], { timeoutMs: 10_000 });
    const running = v.exitCode === 0 ? v.stdout.trim().split(/\s+/).pop() ?? null : null;
    const ap = await deps.cli(['autopilot', '--status', '--json'], { timeoutMs: 20_000 });
    const [doctor, stats] = await Promise.all([
      call('run_doctor', {}).catch((e) => ({ error: String(e.message ?? e) })),
      call('get_stats', {}).catch((e) => ({ error: String(e.message ?? e) })),
    ]);
    return c.json({
      pin: { expected: deps.env.gbrainVersion, running, matches: running === deps.env.gbrainVersion },
      coreLock: checkCoreLock(await readLockInput(paths())),
      autopilot: lastJson(ap.stdout) ?? { exitCode: ap.exitCode },
      doctor,
      stats,
    });
  });

  return r;
}
