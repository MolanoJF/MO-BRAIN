import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { composeUp, composeDown, composeExec, resetBrain, seedGitSource, BRAIN_DB_URL } from '../helpers/stack.ts';

const COMPOSE_FILE = 'compose/docker-compose.slice0.yml';
const MCP_BIND = '127.0.0.1';
const MCP_PORT = 3131;
const MCP_URL = `http://${MCP_BIND}:${MCP_PORT}/mcp`;
const ISSUER_URL = `http://${MCP_BIND}:${MCP_PORT}`;
const CREDS_FILE = '/srv/gbrain-home/.creds-revoke-probe.json';
const MEMBER_HOME = '/srv/gbrain-home/member-revoke-probe';

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
}, 900_000);
afterAll(async () => { await composeDown(); }, 120_000);

function startServe() {
  return Bun.spawn(
    ['docker', 'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'gbrain-ops',
      'gbrain', 'serve', '--http', '--bind', MCP_BIND, '--port', String(MCP_PORT)],
    { stdout: 'pipe', stderr: 'pipe' },
  );
}

async function waitForServe(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const probe = await composeExec('gbrain-ops', [
      'bun', '-e',
      `const r = await fetch(${JSON.stringify(`${ISSUER_URL}/.well-known/gbrain`)}).catch(() => null); ` +
      'if (r && r.ok) console.log("ready");',
    ]);
    if (probe.stdout.includes('ready')) return;
    await Bun.sleep(1000);
  }
  throw new Error(`gbrain serve did not become ready at ${ISSUER_URL} within 60s`);
}

async function stopServe(local: ReturnType<typeof startServe>): Promise<void> {
  local.kill();
  await composeExec('gbrain-ops', [
    'bun', '-e',
    "const fs=require('fs'); for (const pid of fs.readdirSync('/proc')) { " +
    "if (!/^[0-9]+$/.test(pid) || Number(pid) === process.pid) continue; " +
    "try { const cmd = fs.readFileSync('/proc/'+pid+'/cmdline','utf8'); " +
    "if (cmd.indexOf('gbrain') >= 0 && cmd.indexOf('serve') >= 0) process.kill(Number(pid), 'SIGTERM'); " +
    "} catch (e) {} }",
  ]);
}

// V17: the command IS json on stdout; we do not pass --json.
test('mcp.profiles prints the authoritative profile list and default', async () => {
  const spec = OPERATIONS['mcp.profiles']!;
  const r = await execOperation(spec, {});
  assertOk(spec, r);
  const body = JSON.parse(r.stdout) as {
    profiles?: unknown; default?: string; delegation_spending?: string; concurrency?: number;
  };
  expect(body.default).toBe('memory-writer');
  expect(body.profiles).toBeDefined();
  expect(body.delegation_spending).toBe('unlimited');
  expect(body.concurrency).toBe(1);
});

// V15: requesting --json throws in buildArgv; gbrain never sees the flag.
test('buildArgv throws when json:true is requested for auth.revokeClient', () => {
  expect(() => buildArgv(OPERATIONS['auth.revokeClient']!, { clientId: 'x' }, { json: true }))
    .toThrow('auth.revokeClient does not support --json');
});

// V15: not-found is exit 1, and okExitCodes:[0] therefore surfaces it as ok:false.
test('auth.revokeClient on an unknown id exits 1 and is not ok', async () => {
  const spec = OPERATIONS['auth.revokeClient']!;
  const r = await execOperation(spec, { clientId: 'gbrain_cl_does_not_exist' });
  expect(r.exitCode).toBe(1);
  const ok = spec.okExitCodes.includes(r.exitCode);
  expect(ok).toBe(false);
});

// Revocation proof is the thin client's whoami/search failing AFTER revoke,
// not revoke stdout. Grant → init.mcpOnly into a scratch GBRAIN_HOME is the
// same pattern scripts/tutorial.ts uses for the isolation check.
test('a thin-client token stops working after auth.revokeClient', async () => {
  const serve = startServe();
  try {
    await waitForServe();

    const grantSpec = OPERATIONS['mcp.grant']!;
    const grant = await execOperation(grantSpec, {
      name: 'revoke-probe',
      harness: 'generic', profile: 'memory-writer',
      source: 'customers', federatedRead: ['customers'],
      url: MCP_URL,
      credentialsOut: CREDS_FILE,
      tokenTtl: '300',
    }, { json: true });
    assertOk(grantSpec, grant);

    const cat = await composeExec('gbrain-ops', ['cat', CREDS_FILE]);
    expect(cat.exitCode).toBe(0);
    const creds = JSON.parse(cat.stdout) as { client_id: string; client_secret: string };
    expect(creds.client_id).toBeTruthy();
    expect(creds.client_secret).toBeTruthy();

    const env = { GBRAIN_HOME: MEMBER_HOME };
    assertOk(OPERATIONS['init.mcpOnly']!, await execOperation(OPERATIONS['init.mcpOnly']!, {
      issuerUrl: ISSUER_URL, mcpUrl: MCP_URL,
      oauthClientId: creds.client_id, oauthClientSecret: creds.client_secret,
    }, { json: true, env }));

    const whoBefore = await execOperation(OPERATIONS.whoami!, {}, { json: true, env });
    assertOk(OPERATIONS.whoami!, whoBefore);
    const whoBody = whoBefore.json as { transport?: string } | null;
    expect(whoBody?.transport).toBe('oauth');

    const revokeSpec = OPERATIONS['auth.revokeClient']!;
    const revoked = await execOperation(revokeSpec, { clientId: creds.client_id });
    assertOk(revokeSpec, revoked);
    expect(revoked.exitCode).toBe(0);

    const whoAfter = await execOperation(OPERATIONS.whoami!, {}, { json: true, env, timeoutMs: 60_000 });
    expect(whoAfter.exitCode).not.toBe(0);
    expect(OPERATIONS.whoami!.okExitCodes.includes(whoAfter.exitCode)).toBe(false);

    const searchAfter = await execOperation(OPERATIONS.search!, { query: 'probe' }, { json: true, env, timeoutMs: 60_000 });
    expect(searchAfter.exitCode).not.toBe(0);
    expect(OPERATIONS.search!.okExitCodes.includes(searchAfter.exitCode)).toBe(false);
  } finally {
    await stopServe(serve);
  }
}, 600_000);
