#!/usr/bin/env bun
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { health } from './routes/health.ts';
import { runMigrations } from './db/client.ts';

const app = new Hono();

// S3c: the default logger prints method, path and status — never the body.
app.use('*', logger());

// Everything ours lives under /api. /health and /metrics belong to
// gbrain-serve and are routed to it by Caddy; mounting them here would be a
// live collision.
app.route('/api', health);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;

if (import.meta.main) {
  await runMigrations();
  Bun.serve({ port: Number(process.env.PORT ?? 3150), hostname: '0.0.0.0', fetch: app.fetch });
  console.log(`control-plane listening on :${process.env.PORT ?? 3150}`);
}
