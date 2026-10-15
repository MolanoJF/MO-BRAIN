// test/db/app.ts
import { mkdtemp, mkdir, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type Deps } from '../../src/server/app.ts';
import { FakeGbrainAdmin } from '../unit/fakes.ts';
import { freshDb } from './helpers.ts';
import type { McpCaller } from '../../src/server/gbrain/mcp.ts';
import type { CliResult } from '../../src/server/gbrain/cli.ts';

export type TestWorld = Awaited<ReturnType<typeof world>>;

const defaultCli = async (argv: string[]): Promise<CliResult> => {
  if (argv[0] === '--version') return { exitCode: 0, stdout: 'gbrain 0.60.230.0\n', stderr: '' };
  if (argv[0] === 'schema' && argv[1] === 'active') return { exitCode: 0, stdout: '{"name":"mobrain-brain"}', stderr: '' };
  if (argv[0] === 'autopilot') return { exitCode: 0, stdout: '{"status":"fresh"}', stderr: '' };
  return { exitCode: 0, stdout: '{}', stderr: '' };
};

/** A full app over a fresh DB, a fake gbrain admin, a scriptable MCP and CLI. */
export async function world(opts: { mcp?: (token: string) => McpCaller; cli?: (argv: string[]) => Promise<CliResult> } = {}) {
  const { sql, drop } = await freshDb();
  const home = await mkdtemp(join(tmpdir(), 'mb-home-'));
  const packs = join(import.meta.dir, '..', '..', 'packs');
  for (const [name, file] of [['mobrain-core', 'mobrain-core.json'], ['mobrain-personal', 'mobrain-personal.json'], ['mobrain-brain', 'mobrain-brain.template.json']]) {
    await mkdir(join(home, '.gbrain', 'schema-packs', name!), { recursive: true });
    await cp(join(packs, file!), join(home, '.gbrain', 'schema-packs', name!, 'pack.json'));
  }
  let clock = new Date('2026-10-14T12:00:00Z');
  const admin = new FakeGbrainAdmin(() => clock);
  const deps: Deps = {
    sql,
    env: {
      port: 0, databaseUrl: '', gbrainUrl: 'http://gbrain.test', publicUrl: 'http://127.0.0.1:8787',
      encryptionKey: 'e'.repeat(44), gbrainVersion: '0.60.230.0', uiDir: '/nonexistent', secureCookies: false,
      packsDir: packs, gbrainHome: home,
    },
    admin,
    mcp: opts.mcp ?? (() => (async () => ({})) as McpCaller),
    cli: (opts.cli ?? defaultCli) as Deps['cli'],
    fetch: (async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    now: () => clock,
  };
  const app = createApp(deps);
  return {
    sql, admin, app, deps,
    drop: async () => { await drop(); await rm(home, { recursive: true, force: true }); },
    setNow: (d: Date) => { clock = d; },
    /** Request helper that carries a session cookie or API key. */
    req: (path: string, init: RequestInit & { as?: string } = {}) => {
      const headers = new Headers(init.headers);
      if (init.as?.startsWith('mbk_')) headers.set('authorization', `Bearer ${init.as}`);
      else if (init.as) headers.set('cookie', `mobrain_session=${init.as}`);
      if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
      return app.request(path, { ...init, headers });
    },
  };
}
