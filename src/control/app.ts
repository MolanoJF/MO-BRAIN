#!/usr/bin/env bun
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { health } from './routes/health.ts';
import { authRoutes } from './routes/auth.ts';
import { wizard } from './routes/wizard.ts';
import { backup } from './routes/backup.ts';
import { members } from './routes/members.ts';
import { grantRoutes } from './routes/grants.ts';
import { fileRoutes } from './routes/files.ts';
import { connectionRoutes } from './routes/connections.ts';
import { schemaRoutes } from './routes/schema.ts';
import { sourceRoutes } from './routes/sources.ts';
import { scheduleRoutes } from './routes/schedules.ts';
import { upgrades } from './routes/upgrades.ts';
import { claimRoutes } from './routes/claim.ts';
import { runRoutes } from './routes/runs.ts';
import { gatewayRoutes } from './routes/gateway.ts';
import { spendRoutes } from './routes/spend.ts';
import { getDb, runMigrations } from './db/client.ts';
import { reconcileJournals, UPGRADE_RECONCILE_INTERVAL_MS } from '../upgrade/reconcile.ts';

const app = new Hono();

// S3c: the default logger prints method, path and status — never the body.
app.use('*', logger());

// Everything ours lives under /api. /health and /metrics belong to
// gbrain-serve and are routed to it by Caddy; mounting them here would be a
// live collision.
app.route('/api', health);
app.route('/api', authRoutes);
app.route('/api/wizard', wizard);
app.route('/api', backup);
app.route('/api', members);
app.route('/api', grantRoutes);
// S1: the read-only Space Files browse lives under /api/spaces.
app.route('/api', fileRoutes);
app.route('/api', connectionRoutes);
app.route('/api', schemaRoutes);
app.route('/api', sourceRoutes);
app.route('/api', scheduleRoutes);
app.route('/api', upgrades);
app.route('/api', spendRoutes);
app.route('/api', claimRoutes);
// Slice 4 (Task 6, Task 7): the runner's two surfaces. Neither is ever routed
// publicly — Caddy gains no route for /api/runs or /api/gateway, and the runner
// reaches both directly on runner-net (D6). The gateway mount is the whole
// contract Task 7 asked for: the harness's own paths land at
// POST /api/gateway/v1/messages and HEAD /api/gateway/api/hello (F4).
app.route('/api/runs', runRoutes);
app.route('/api/gateway', gatewayRoutes);

// Live collisions with gbrain-serve. Caddy routes these away in production;
// refuse them here so a direct hit never returns the SPA.
app.get('/health', (c) => c.json({ error: 'not_found' }, 404));
app.get('/metrics', (c) => c.json({ error: 'not_found' }, 404));

// The SPA. Everything not under /api falls through to index.html so client
// routing works; /health and /metrics never reach here — Caddy sends them to
// gbrain-serve.
app.use('/assets/*', serveStatic({ root: './dist/console' }));
app.get('*', serveStatic({ path: './dist/console/index.html' }));

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;

/**
 * F14. Bun's `idleTimeout` defaults to 10 s, and it is a *connection* timer:
 * when it fires on a request whose handler has not written a byte yet, the
 * socket is closed and the client sees EOF — through Caddy, a `502` — instead
 * of the route's own answer. Measured on this Bun (1.3.13, same container):
 * a default server severs a body-less `GET` handler that is still working at
 * 12.0 s, while the identical handler on `idleTimeout: 120` answers at 15.0 s.
 *
 * Two routes here legitimately take longer than 10 s to their first byte:
 *
 *   - `POST /api/runs/claim` holds the request for `RUN_CLAIM_WAIT_MS` (25 s
 *     by default) by design. It survives today only by Bun implementation
 *     detail: a request that carries a body is not severed this way (measured
 *     `204` at 25.074 s on the live server, and 15.0 s for a synthetic POST)
 *     — the claim's safety is not something the route asked for.
 *   - `/api/health` is an unauthenticated readiness surface whose honest
 *     worst case is an ops round trip: `checkUpdate` measured 3.2–5.9 s and
 *     `doctor` 8.0–39.0 s through the same relay. A severed connection turns
 *     its honest `503` into a `502` with no body.
 *
 * 60 s is `RUN_CLAIM_WAIT_MS` × 2.4: above the 40 s ceiling the runner's own
 * client waits (`CLAIM_WAIT_MS + CLAIM_SLACK_MS`), above the 30 s the runner
 * docs call "the common proxy idle timeout", and well under Bun's 255 s
 * maximum. It still reaps a half-open socket within a minute.
 */
const IDLE_TIMEOUT_S = 60;

if (import.meta.main) {
  await runMigrations();
  const upgradeDir = process.env.UPGRADE_DIR ?? '/srv/upgrades';
  // Boot reconcile: the control plane was down for most of any upgrade that
  // ran while it was offline, so this is the first chance to see it.
  await reconcileJournals(getDb(), upgradeDir)
    .catch((e) => console.error('[upgrade] boot reconcile failed:', e));
  setInterval(() => {
    void reconcileJournals(getDb(), upgradeDir)
      .catch((e) => console.error('[upgrade] reconcile failed:', e));
  }, UPGRADE_RECONCILE_INTERVAL_MS);
  Bun.serve({
    port: Number(process.env.PORT ?? 3150),
    hostname: '0.0.0.0',
    idleTimeout: IDLE_TIMEOUT_S,
    fetch: app.fetch,
  });
  console.log(`control-plane listening on :${process.env.PORT ?? 3150}`);
}
