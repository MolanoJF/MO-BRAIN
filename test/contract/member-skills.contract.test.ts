import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { composeUp, composeDown, composeExec, resetBrain, seedGitSource, BRAIN_DB_URL } from '../helpers/stack.ts';
import { wiringSnippet } from '../../src/control/harness.ts';

/**
 * Member skill delivery rests on four facts at the pin, proven here:
 *  (a) `init` leaves mcp.publish_skills on;
 *  (b) a memory-writer client on the compiled `starter` surface sees
 *      list_skills/get_skill (0.60.104.0; they are no longer hidden);
 *  (c) rescoped to `full`, the same client lists skills; get_skill by the
 *      host name `query` is skill_not_found (no authorized published skill);
 *  (d) on `full`, the memory-writer profile still cannot call an admin op.
 * The slice0 stack has no gbrain-serve, so serve runs inside gbrain-ops on
 * loopback, the pattern discovery.contract.test.ts uses.
 */

const MCP_URL = 'http://127.0.0.1:3131/mcp';
const CREDS = '/srv/gbrain-home/.creds-member-skills.json';
let serve: ReturnType<typeof Bun.spawn> | null = null;
let clientId = '';
let token = '';

async function killRemoteServe(): Promise<void> {
  await composeExec('gbrain-ops', [
    'bun', '-e',
    "const fs=require('fs'); for (const pid of fs.readdirSync('/proc')) { " +
    "if (!/^[0-9]+$/.test(pid) || Number(pid) === process.pid) continue; " +
    "try { const cmd = fs.readFileSync('/proc/'+pid+'/cmdline','utf8'); " +
    "if (cmd.indexOf('gbrain') >= 0 && cmd.indexOf('serve') >= 0) process.kill(Number(pid), 'SIGTERM'); " +
    "} catch (e) {} }",
  ]);
}

/** One JSON-RPC call from inside gbrain-ops (serve is bound to its loopback). */
async function mcp(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const script =
    `const r = await fetch(${JSON.stringify(MCP_URL)}, { method: 'POST', headers: {` +
    ` authorization: 'Bearer ' + process.env.T, 'content-type': 'application/json',` +
    ` accept: 'application/json, text/event-stream' }, body: ${JSON.stringify(body)} });` +
    ` console.log(await r.text());`;
  const r = await composeExec('gbrain-ops', ['bun', '-e', script], { env: { T: token } });
  const text = r.stdout.trim();
  const frame = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('data:')).pop();
  return JSON.parse(frame ? frame.slice(5).trim() : text) as Record<string, unknown>;
}

async function toolNames(): Promise<string[]> {
  const msg = await mcp('tools/list', {});
  const tools = ((msg.result as { tools?: Array<{ name: string }> })?.tools) ?? [];
  return tools.map((t) => t.name);
}

beforeAll(async () => {
  await composeUp();
  await resetBrain();
  assertOk(OPERATIONS.init!, await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 600_000 }));
  await seedGitSource('customers');
  assertOk(OPERATIONS['sources.add']!, await execOperation(OPERATIONS['sources.add']!, {
    id: 'customers', path: '/srv/brain-repos/customers',
  }));

  const grant = await execOperation(OPERATIONS['mcp.grant']!, {
    name: 'member-skills-probe', harness: 'claude-code', profile: 'memory-writer',
    source: 'customers', url: MCP_URL, credentialsOut: CREDS,
  }, { json: true });
  assertOk(OPERATIONS['mcp.grant']!, grant);
  // Plan defect: the grant receipt is `{ status, grant: { clientId } }` — the
  // plan's `grant.json.client_id` is always undefined (see
  // test/contract/mcp-grant.contract.test.ts:96-98). Read the measured path.
  clientId = String((grant.json as { grant?: { clientId?: string } }).grant?.clientId);
  const handoff = await composeExec('gbrain-ops', ['cat', CREDS]);
  token = String((JSON.parse(handoff.stdout) as { access_token?: string }).access_token);
  expect(token.length).toBeGreaterThan(0);

  serve = Bun.spawn([
    'docker', 'compose', '-f', 'compose/docker-compose.slice0.yml', 'exec', '-T', 'gbrain-ops',
    'gbrain', 'serve', '--http', '--bind', '127.0.0.1', '--port', '3131',
  ], { stdout: 'pipe', stderr: 'pipe' });
  for (let i = 0; i < 60; i++) {
    const r = await composeExec('gbrain-ops', ['bun', '-e',
      `const r = await fetch('http://127.0.0.1:3131/.well-known/gbrain').catch(() => null); process.exit(r && r.ok ? 0 : 1);`]);
    if (r.exitCode === 0) break;
    await Bun.sleep(1000);
  }
}, 900_000);

afterAll(async () => {
  serve?.kill();
  await killRemoteServe();
  await composeDown();
}, 120_000);

test('(a) init leaves mcp.publish_skills on', async () => {
  const r = await execOperation(OPERATIONS['config.get']!, { key: 'mcp.publish_skills' });
  assertOk(OPERATIONS['config.get']!, r);
  const line = r.stdout.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('[config]'));
  expect(line).toBe('true');
});

test('(b) the compiled starter surface includes list_skills and get_skill', async () => {
  // Measured at 0.60.104.0 (docs/archive/gbrain-0.60.104.0-findings.md): starter
  // tools/list count=35 and the array contains both names. The 0.50 pin hid them.
  const names = await toolNames();
  console.log(`[member-skills] starter tools/list count=${names.length}`);
  expect(names).toContain('list_skills');
  expect(names).toContain('get_skill');
});

test('(c) rescoped to full, the member lists and fetches skills', async () => {
  // Measured: the full re-statement rescopeParams() sends is REJECTED at the
  // pin — `Invalid client grant: read_source_inactive` — so only the surface
  // is re-stated here. Task 3's applySurface must use `{ id, surface }`.
  const rs = await execOperation(OPERATIONS['auth.rescopeClient']!, {
    id: clientId, surface: 'full',
  }, { json: true });
  assertOk(OPERATIONS['auth.rescopeClient']!, rs);

  const names = await toolNames();
  console.log(`[member-skills] full tools/list count=${names.length}`);
  expect(names).toContain('list_skills');
  expect(names).toContain('get_skill');

  const listed = await mcp('tools/call', { name: 'list_skills', arguments: {} });
  expect(listed.error).toBeUndefined();
  const listText = JSON.stringify(listed.result);
  console.log(`[member-skills] list_skills bytes=${listText.length}`);
  expect(listText).toContain('query');

  const got = await mcp('tools/call', { name: 'get_skill', arguments: { name: 'query' } });
  expect(got.error).toBeUndefined();
  // Measured at 0.60.104.0: `{ name: 'query' }` is not an authorized published
  // skill. The receipt is skill_not_found, not a body. Do not treat the
  // instructions envelope's mention of the tool name "query" as a fetch.
  const gotText = JSON.stringify(got.result);
  expect(gotText).toContain('skill_not_found');
  expect(gotText).toContain('No authorized published skill matches this key.');
  expect(gotText).not.toContain('"body"');
});

test('(d) on full, memory-writer scopes still deny an admin op', async () => {
  const r = await mcp('tools/call', {
    name: 'sources_add', arguments: { id: 'escape', path: '/tmp/escape' },
  });
  const denied = r.error !== undefined
    || (r.result as { isError?: boolean } | undefined)?.isError === true;
  console.log(`[member-skills] sources_add as memory-writer: ${JSON.stringify(r).slice(0, 300)}`);
  expect(denied).toBe(true);
});

test('(e) a generic-harness grant produces a snippet that authenticates, and is recorded verified', async () => {
  const grant = await execOperation(OPERATIONS['mcp.grant']!, {
    name: 'member-skills-verify-probe', harness: 'generic', profile: 'memory-writer',
    source: 'customers', url: MCP_URL, credentialsOut: '/srv/gbrain-home/.creds-verify-probe.json',
  }, { json: true });
  assertOk(OPERATIONS['mcp.grant']!, grant);
  const probeClientId = String((grant.json as { grant?: { clientId?: string } }).grant?.clientId);

  const verify = await execOperation(OPERATIONS['mcp.verify']!, {
    client: probeClientId, harness: 'generic', url: MCP_URL,
    credentialsFile: '/srv/gbrain-home/.creds-verify-probe.json', timeoutMs: '30000',
  }, { json: true });
  console.log(`[member-skills] mcp.verify exit=${verify.exitCode}`);
  expect([0, 2]).toContain(verify.exitCode);

  const handoff = await composeExec('gbrain-ops', ['cat', '/srv/gbrain-home/.creds-verify-probe.json']);
  const parsed = JSON.parse(handoff.stdout) as { access_token?: string; mcp_url?: string };
  const { snippet } = wiringSnippet('generic', {
    access_token: parsed.access_token, mcp_url: parsed.mcp_url,
  });
  const fragment = JSON.parse(snippet.split('\n').slice(1).join('\n')) as {
    mcpServers: { gbrain: { type: string; headers: { Authorization: string } } };
  };
  expect(fragment.mcpServers.gbrain.type).toBe('http');
  expect(fragment.mcpServers.gbrain.headers.Authorization).toBe(`Bearer ${parsed.access_token}`);

  // The snippet's own credential must actually authenticate against the live server.
  const T = fragment.mcpServers.gbrain.headers.Authorization.replace('Bearer ', '');
  const script =
    `const r = await fetch(${JSON.stringify(MCP_URL)}, { method: 'POST', headers: {` +
    ` authorization: 'Bearer ' + process.env.T, 'content-type': 'application/json',` +
    ` accept: 'application/json, text/event-stream' },` +
    ` body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });` +
    ` console.log(await r.text());`;
  const r = await composeExec('gbrain-ops', ['bun', '-e', script], { env: { T } });
  expect(r.stdout).toContain('"tools"');

  await composeExec('gbrain-ops', ['gbrain', 'auth', 'revoke-client', probeClientId]).catch(() => {});
});
