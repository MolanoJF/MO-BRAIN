import { createApp } from './app.ts';
import { connect } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { loadEnv } from './env.ts';
import { HttpGbrainAdmin } from './gbrain/admin.ts';
import { runGbrain } from './gbrain/cli.ts';
import { mcpCaller } from './gbrain/mcp.ts';

const env = loadEnv();
const sql = connect(env.databaseUrl);
const applied = await migrate(sql);
if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);

const app = createApp({
  sql,
  env,
  // gbrain's owner admin HTTP API lives on the same origin as MCP. Issue over
  // it with the bootstrap token; only the credential URL is the public origin.
  admin: new HttpGbrainAdmin(fetch, env.gbrainUrl, env.publicUrl, env.gbrainAdminToken),
  mcp: (token) => mcpCaller(`${env.gbrainUrl}/mcp`, token),
  cli: runGbrain,
  fetch,
  now: () => new Date(),
});

export default { port: env.port, fetch: app.fetch, idleTimeout: 120 };
console.log(`mobrain listening on :${env.port}`);
