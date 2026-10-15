import { createApp } from './app.ts';
import { connect } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { loadEnv } from './env.ts';
import { CliGbrainAdmin } from './gbrain/admin.ts';
import { runGbrain } from './gbrain/cli.ts';
import { mcpCaller } from './gbrain/mcp.ts';

const env = loadEnv();
const sql = connect(env.databaseUrl);
const applied = await migrate(sql);
if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);

const app = createApp({
  sql,
  env,
  // Probe P2: 127.0.0.1:8788/mcp is admin_unreachable inside a container. Listen address inside gbrain is http://127.0.0.1:3131/mcp; this process is in mobrain, so use GBRAIN_URL.
  admin: new CliGbrainAdmin(runGbrain, env.gbrainUrl),
  mcp: (token) => mcpCaller(`${env.gbrainUrl}/mcp`, token),
  cli: runGbrain,
  fetch,
  now: () => new Date(),
});

export default { port: env.port, fetch: app.fetch, idleTimeout: 120 };
console.log(`mobrain listening on :${env.port}`);
