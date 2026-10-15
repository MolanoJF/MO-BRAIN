import { Hono } from 'hono';
import type { AppEnv } from '../http.ts';
import type { Deps } from '../app.ts';

/** Unauthenticated liveness: DB reachable, gbrain reachable, pin matches. */
export function healthRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/api/health', async (c) => {
    const db = await deps.sql`select 1`.then(() => true, () => false);
    const v = await deps.cli(['--version'], { timeoutMs: 10_000 });
    const running = v.exitCode === 0 ? v.stdout.trim().split(/\s+/).pop() ?? null : null;
    const gbrain = await deps.fetch(`${deps.env.gbrainUrl}/health`, { signal: AbortSignal.timeout(5000) })
      .then((x) => x.ok, () => false);
    const pin = { expected: deps.env.gbrainVersion, running, matches: running === deps.env.gbrainVersion };
    const ok = db && gbrain && pin.matches;
    return c.json({ ok, db, gbrain, pin }, ok ? 200 : 503);
  });
  return r;
}
