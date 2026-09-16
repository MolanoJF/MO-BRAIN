import { Hono } from 'hono';
import { desc, isNull, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { opsHealthy, callOps, inspectRepos } from '../opsClient.ts';

export const health = new Hono();

/**
 * gbrain `sources status --json` returns an envelope object
 * (`{ schema_version, generated_at, sources, … }`), not a top-level array.
 * Accept a bare array too in case the shape ever flattens.
 */
export function reposFromSourcesStatus(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object' && Array.isArray((json as { sources?: unknown }).sources)) {
    return (json as { sources: unknown[] }).sources;
  }
  return [];
}

/**
 * Unacknowledged schedule alerts, KINDS ONLY.
 *
 * `/api/health` is reachable without a session — it is the compose healthcheck
 * — so `detail` must never appear here: a `push_blocked` detail can name a file
 * path that matched a secret scan, and a `connection_revoked` detail names a
 * client. Kinds and counts are what a healthcheck needs; the operators get the
 * details from the authenticated `/api/schedule-alerts`.
 */
async function openAlerts(): Promise<
  Array<{ id: string; kind: string; scheduleId: string | null; at: Date }>
> {
  try {
    return await getDb()
      .select({
        id: schema.scheduleAlerts.id,
        kind: schema.scheduleAlerts.kind,
        scheduleId: schema.scheduleAlerts.scheduleId,
        at: schema.scheduleAlerts.at,
      })
      .from(schema.scheduleAlerts)
      .where(isNull(schema.scheduleAlerts.acknowledgedAt))
      .orderBy(desc(schema.scheduleAlerts.at))
      .limit(20);
  } catch {
    // A health endpoint reports; it never 500s because one probe failed.
    return [];
  }
}

health.get('/health', async (c) => {
  const components: Record<string, 'ok' | 'down'> = { controlDb: 'down', ops: 'down' };
  let gbrainVersion: string | null = null;

  try { await getDb().execute(sql`select 1`); components.controlDb = 'ok'; } catch { /* reported as down */ }

  if (await opsHealthy()) {
    components.ops = 'ok';
    try {
      const r = await callOps('toolsJson', {}, { timeoutMs: 10_000 });
      if (r.ok) gbrainVersion = process.env.GBRAIN_VERSION ?? null;
    } catch { /* version stays null */ }
  }

  // inspectRepos: stale index.lock plus uncommitted/unpushed drift. Sync
  // imports commits, not the working tree, so uncommitted files are pages
  // the brain cannot see yet.
  let repos: unknown[] = [];
  if (components.ops === 'ok') {
    try { repos = await inspectRepos(); } catch { repos = []; }
  }

  const ok = Object.values(components).every((s) => s === 'ok');
  const scheduleAlerts = components.controlDb === 'ok' ? await openAlerts() : [];
  // Never include a connection string, a token or an env dump here.
  return c.json(
    { ok, components, gbrainVersion, repos, scheduleAlerts, at: new Date().toISOString() },
    ok ? 200 : 503,
  );
});
