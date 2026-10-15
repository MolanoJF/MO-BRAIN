import { Hono } from 'hono';
import type { Sql } from './db/index.ts';
import type { Env } from './env.ts';
import type { GbrainAdmin } from './gbrain/admin.ts';
import type { McpCaller } from './gbrain/mcp.ts';
import type { runGbrain } from './gbrain/cli.ts';
import { authenticate, onError, type AppEnv } from './http.ts';
import { authRoutes } from './routes/auth.ts';
import { brainRoutes } from './routes/brain.ts';
import { healthRoutes } from './routes/health.ts';
import { peopleRoutes } from './routes/people.ts';
import { proxyRoutes } from './routes/proxy.ts';
import { runnerRoutes } from './routes/runner.ts';
import { schemaRoutes } from './routes/schema.ts';

export type Deps = {
  sql: Sql;
  env: Env;
  admin: GbrainAdmin;
  mcp: (token: string) => McpCaller;
  cli: typeof runGbrain;
  fetch: typeof fetch;
  now: () => Date;
};

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.route('/', proxyRoutes(deps.env.gbrainUrl, deps.fetch));
  app.use('/api/*', authenticate(deps.sql, deps.now));
  app.route('/', healthRoutes(deps));
  app.route('/', authRoutes(deps));
  app.route('/', peopleRoutes(deps));
  app.route('/', schemaRoutes(deps));
  app.route('/', runnerRoutes(deps));
  app.route('/', brainRoutes(deps));
  return app;
}
