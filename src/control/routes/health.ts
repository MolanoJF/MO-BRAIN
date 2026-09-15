import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.ts';
import { opsHealthy, callOps } from '../opsClient.ts';

export const health = new Hono();

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

  const ok = Object.values(components).every((s) => s === 'ok');
  // Never include a connection string, a token or an env dump here.
  return c.json({ ok, components, gbrainVersion, at: new Date().toISOString() }, ok ? 200 : 503);
});
