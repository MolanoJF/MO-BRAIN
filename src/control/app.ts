#!/usr/bin/env bun
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { health } from './routes/health.ts';
import { authRoutes } from './routes/auth.ts';
import { wizard } from './routes/wizard.ts';
import { runMigrations } from './db/client.ts';

const app = new Hono();

// S3c: the default logger prints method, path and status — never the body.
app.use('*', logger());

// Everything ours lives under /api. /health and /metrics belong to
// gbrain-serve and are routed to it by Caddy; mounting them here would be a
// live collision.
app.route('/api', health);
app.route('/api', authRoutes);
app.route('/api/wizard', wizard);

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
  Bun.serve({ port: Number(process.env.PORT ?? 3150), hostname: '0.0.0.0', fetch: app.fetch });
  console.log(`control-plane listening on :${process.env.PORT ?? 3150}`);
}
