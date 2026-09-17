#!/usr/bin/env bun
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { health } from './routes/health.ts';
import { authRoutes } from './routes/auth.ts';
import { wizard } from './routes/wizard.ts';
import { backup } from './routes/backup.ts';
import { members } from './routes/members.ts';
import { connectionRoutes } from './routes/connections.ts';
import { scheduleRoutes } from './routes/schedules.ts';
import { upgrades } from './routes/upgrades.ts';
import { claimRoutes } from './routes/claim.ts';
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
app.route('/api', connectionRoutes);
app.route('/api', scheduleRoutes);
app.route('/api', upgrades);
app.route('/api', claimRoutes);

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
  Bun.serve({ port: Number(process.env.PORT ?? 3150), hostname: '0.0.0.0', fetch: app.fetch });
  console.log(`control-plane listening on :${process.env.PORT ?? 3150}`);
}
