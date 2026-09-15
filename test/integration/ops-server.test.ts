import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:3140';
const TOKEN = 'integration-token-not-a-real-secret';
const CONTROL_DATABASE_URL =
  process.env.CONTROL_DATABASE_URL ?? 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

let server: ReturnType<typeof Bun.spawn>;
let homeDir: string;

beforeAll(async () => {
  // Ruling 14: fileplane binds CONFIG_PATH from GBRAIN_HOME at module load.
  // Without a temp dir here the server would write to /srv/gbrain-home.
  homeDir = await mkdtemp(join(tmpdir(), 'bs-ops-'));
  server = Bun.spawn(['bun', 'run', 'src/ops/server.ts'], {
    env: {
      ...process.env,
      OPS_RPC_TOKEN: TOKEN,
      OPS_RPC_PORT: '3140',
      CONTROL_DATABASE_URL,
      GBRAIN_HOME: homeDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch {}
    await Bun.sleep(200);
  }
  throw new Error('ops server did not start');
}, 30_000);

afterAll(async () => {
  server?.kill();
  if (homeDir) await rm(homeDir, { recursive: true, force: true });
});

const rpc = (body: unknown, token = TOKEN) =>
  fetch(`${BASE}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe('ops rpc', () => {
  test('healthz needs no token', async () => {
    expect((await fetch(`${BASE}/healthz`)).ok).toBe(true);
  });

  test('rpc without a token is 401', async () => {
    const r = await fetch(`${BASE}/rpc`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
  });

  test('rpc with the wrong token is 401', async () => {
    expect((await rpc({ op: 'sources.list', params: {} }, 'wrong')).status).toBe(401);
  });

  // S2: there is no passthrough. An unlisted operation is unreachable.
  test('an unregistered operation is 400, not executed', async () => {
    const r = await rpc({ op: 'serve; rm -rf /', params: {} });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/unknown operation/);
  });

  test('a smuggled argv param is rejected', async () => {
    const r = await rpc({ op: 'sources.list', params: { _argv: ['x'] } });
    expect(r.status).toBe(400);
  });

  test('the fileplane config route never echoes the patch back', async () => {
    const r = await fetch(`${BASE}/fileplane/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ patch: { openai_api_key: 'sk-should-not-appear' } }),
    });
    const text = await r.text();
    expect(text).not.toContain('sk-should-not-appear');
    expect(text).toContain('openai_api_key'); // the key NAME is fine
  });

  test('seed-space rejects an invalid sourceId', async () => {
    const r = await fetch(`${BASE}/fileplane/seed-space`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sourceId: '../etc' }),
    });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/invalid sourceId/);
  });
});
