/**
 * Spec agent-control-mcp §11 integration, through Caddy on the dev stack:
 * the owner's real Connection bearer → /api/control-mcp → whoami via ops →
 * tools. Ends with "create a schema → preview → apply → sync". Needs the stack
 * built from this branch, and PROBE_OWNER_EMAIL / PROBE_OWNER_PASSWORD.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

const BASE = process.env.PROBE_CONSOLE_URL ?? 'https://localhost:8443';
const EMAIL = process.env.PROBE_OWNER_EMAIL;
const PASSWORD = process.env.PROBE_OWNER_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error('set PROBE_OWNER_EMAIL and PROBE_OWNER_PASSWORD');
const insecure = { tls: { rejectUnauthorized: false } } as RequestInit;

let bearer = '';
let restorePack: string | null = null;

async function mcp(method: string, params: unknown = {}) {
  const res = await fetch(`${BASE}/api/control-mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), ...insecure,
  });
  expect(res.status).toBe(200);
  return (await res.json() as any).result;
}
const tool = (name: string, args: Record<string, unknown> = {}) => mcp('tools/call', { name, arguments: args });

describe('control MCP end to end', () => {
  test('the owner\'s /my/mcp handoff declares the control server', async () => {
    const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }), ...insecure,
    });
    const cookie = signIn.headers.get('set-cookie') ?? '';
    const mine = await (await fetch(`${BASE}/api/my/mcp`, { headers: { cookie }, ...insecure })).json() as any;
    expect(mine.control_url).toMatch(/\/api\/control-mcp$/);
    expect(mine.snippet).toContain('mobrain-control');
    bearer = mine.credentials.access_token;
  });

  test('initialize and tools/list as the owner', async () => {
    const init = await mcp('initialize', { protocolVersion: '2025-06-18' });
    expect(init.serverInfo.name).toBe('mobrain-control');
    const { tools } = await mcp('tools/list');
    expect(tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['org_get', 'schema_apply', 'org_set_mode']));
  });

  test('create a schema → preview → apply → sync', async () => {
    const before = await tool('schema_get');
    restorePack = before.structuredContent.active.pack;
    const name = `e2e-${randomUUID().slice(0, 8)}`;
    const created = await tool('schema_pack_create', { mode: 'fork', from: restorePack, name });
    console.log(`MEASURED schema_pack_create ok=${created.structuredContent.ok}`);
    expect(created.isError).toBe(false);

    const preview = await tool('schema_apply', { pack: name });
    expect(preview.structuredContent.preview).toBe(true);
    const applied = await tool('schema_apply', { pack: name, confirm: preview.structuredContent.confirmToken });
    console.log(`MEASURED schema_apply isError=${applied.isError} status=${applied.structuredContent.status ?? 200}`);
    expect(applied.isError).toBe(false);

    const dry = await tool('schema_preview');
    expect(dry.isError).toBe(false);
    const sync = await tool('schema_sync', { scope: 'brain' });
    console.log(`MEASURED schema_sync applied=${sync.structuredContent.total_applied}`);
    expect(sync.isError).toBe(false);
  });

  test('restore the original pack', async () => {
    if (!restorePack) return;
    const p = await tool('schema_apply', { pack: restorePack });
    const r = await tool('schema_apply', { pack: restorePack, confirm: p.structuredContent.confirmToken });
    expect(r.isError).toBe(false);
  });
});
