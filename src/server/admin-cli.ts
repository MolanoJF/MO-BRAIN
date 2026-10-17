import type { Deps } from './app.ts';
import { hashPassword } from './auth.ts';
import { newToken } from './crypto.ts';
import { PeopleService } from './people/service.ts';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function runAdminCli(argv: string[], deps: Deps): Promise<string> {
  const people = new PeopleService(deps);
  const [cmd] = argv;
  if (cmd === 'bootstrap') {
    const email = flag(argv, 'email');
    if (!email) throw new Error('usage: bootstrap --email <e> [--name <n>]');
    const r = await people.bootstrapOwner({ email, name: flag(argv, 'name') });
    if (flag(argv, 'format') === 'env') {
      return `MOBRAIN_USER_ID=${r.userId}\nMOBRAIN_API_KEY=${r.apiKey}\nMOBRAIN_OWNER_PASSWORD=${r.password}`;
    }
    return JSON.stringify(r);
  }
  if (cmd === 'reset-password') {
    const email = flag(argv, 'email');
    if (!email) throw new Error('usage: reset-password --email <e>');
    const user = await people.userByEmail(email.toLowerCase());
    const password = newToken().slice(0, 24);
    await deps.sql`update users set password_hash = ${await hashPassword(password)} where id = ${user.id}`;
    await deps.sql`delete from sessions where user_id = ${user.id}`;
    return JSON.stringify({ email: user.email, password });
  }
  throw new Error('usage: admin-cli.ts bootstrap|reset-password ...');
}

if (import.meta.main) {
  const { loadEnv } = await import('./env.ts');
  const { connect } = await import('./db/index.ts');
  const { migrate } = await import('./db/migrate.ts');
  const { HttpGbrainAdmin } = await import('./gbrain/admin.ts');
  const { runGbrain } = await import('./gbrain/cli.ts');
  const { mcpCaller } = await import('./gbrain/mcp.ts');
  const env = loadEnv();
  const sql = connect(env.databaseUrl);
  await migrate(sql);
  try {
    console.log(await runAdminCli(process.argv.slice(2), {
      sql, env, admin: new HttpGbrainAdmin(fetch, env.gbrainUrl, env.publicUrl, env.gbrainAdminToken),
      mcp: (t) => mcpCaller(`${env.gbrainUrl}/mcp`, t), cli: runGbrain, fetch, now: () => new Date(),
    }));
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
