import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.ts';
import { opsHealthy, callOps } from '../opsClient.ts';

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

  // Show uncommitted drift rather than pretending a saved page is indexed:
  // sync imports commits, not the working tree.
  let repos: unknown[] = [];
  if (components.ops === 'ok') {
    try {
      const r = await callOps<unknown>('sources.status', {}, { json: true, timeoutMs: 30_000 });
      repos = reposFromSourcesStatus(r.json);
    } catch { repos = []; }
  }

  const ok = Object.values(components).every((s) => s === 'ok');
  // Never include a connection string, a token or an env dump here.
  return c.json({ ok, components, gbrainVersion, repos, at: new Date().toISOString() }, ok ? 200 : 503);
});
