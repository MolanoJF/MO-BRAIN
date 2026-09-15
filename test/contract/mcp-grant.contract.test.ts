import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { composeUp, composeDown, composeExec, resetBrain, seedGitSource, BRAIN_DB_URL } from '../helpers/stack.ts';

beforeAll(async () => {
  await composeUp();
  await resetBrain();
  assertOk(OPERATIONS.init!, await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 600_000 }));
  // Work Item D: `sources add --path` requires a git-initialized repo with a
  // committed file, not a bare dir (see Task 7's defect note).
  for (const id of ['shared', 'customers']) {
    await seedGitSource(id);
    assertOk(OPERATIONS['sources.add']!, await execOperation(OPERATIONS['sources.add']!, {
      id, path: `/srv/brain-repos/${id}`,
    }));
  }
}, 900_000);
afterAll(async () => { await composeDown(); }, 120_000);

// Plan defect (Work Item G): every `mcp.grant` call — dry-run included —
// requires `--url`. Upstream `parseMcpGrant` reads `url: value('--url') ?? ''`
// (src/commands/mcp.ts:68) and `provisionHarnessGrant` validates it with
// `normalizeMcpUrl` + `assertSecureEndpoint` (src/commands/mcp-provision.ts:
// 22-24) before any dry-run branch, so an omitted `--url` fails with
// `{"status":"error","reason":"mcp_setup_failed","message":"Pass a valid MCP
// endpoint URL"}` regardless of --dry-run. Neither check contacts the URL —
// they only validate scheme/shape (https, or http on a loopback host) — so a
// syntactically valid loopback URL is accepted with no `gbrain serve` running.
const MCP_URL = 'http://127.0.0.1:3131/mcp';

// V2: --dry-run --json is the "machine-readable redacted receipt" that becomes
// our before/after confirm screen in Slice 2.
test('mcp grant --dry-run --json previews a grant without creating it', async () => {
  const spec = OPERATIONS['mcp.grant']!;
  const r = await execOperation(spec, {
    name: 'alice-preview',
    harness: 'claude-code', profile: 'memory-writer',
    source: 'customers', federatedRead: ['customers', 'shared'],
    url: MCP_URL,
  }, { json: true, dryRun: true });

  assertOk(spec, r);
  const body = r.json as { status?: string; grant?: unknown; before?: unknown } | null;
  expect(body?.status).toBe('preview');
  expect(body?.grant).toBeDefined();
});

// Plan defect: `auth clients --json` emits an OBJECT
// ({ window_days, usage_included, clients: [...], legacy_tokens: [...] }),
// not a bare array (src/commands/auth.ts, clientsCmd). Unwrap .clients
// before checking array-ness, and actually assert the count is zero — the
// original `Array.isArray(list)` (defaulted to [] on any falsy json) passed
// even when nothing had been proven about mutation.
test('a dry-run grant creates no client', async () => {
  const before = await execOperation(OPERATIONS['auth.clients']!, {}, { json: true });
  const body = (before.json ?? {}) as { clients?: unknown[] };
  expect(Array.isArray(body.clients)).toBe(true);
  expect(body.clients!.length).toBe(0);
});

// V8: mcp grant needs a local engine OR --admin-token-file. This is the whole
// reason gbrain-ops exists as a separate privilege boundary (S2).
//
// Plan defect (Work Item F): the plan's raw argv also omitted the required
// positional NAME. Without it, `mcp grant` fails at arg-parsing ("Usage:
// gbrain mcp grant NAME [options]") before ever attempting the DB connect —
// exit code is non-zero either way, so the original test "passed" without
// actually exercising the V8 DB-unreachable path. Added a NAME so the
// failure is provably the DB-access one (manually confirmed: with a NAME and
// this bogus URL, gbrain prints "GBRAIN_DB_ACCESS conn_refused ... Cannot
// connect to database").
test('mcp grant without brain DB access fails with the documented guidance', async () => {
  const r = await composeExec('gbrain-ops', [
    'gbrain', 'mcp', 'grant', 'probe-client', '--harness', 'claude-code', '--source', 'customers', '--json',
  ], { env: { GBRAIN_DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/none' } });
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(/GBRAIN_DB_ACCESS|Cannot connect to database|connect ECONNREFUSED/);
});

test('a real grant emits a client_id and a credentials receipt', async () => {
  const spec = OPERATIONS['mcp.grant']!;
  const r = await execOperation(spec, {
    name: 'alice-generic',
    harness: 'generic', profile: 'memory-writer',
    source: 'customers', federatedRead: ['customers', 'shared'],
    url: MCP_URL,
    credentialsOut: '/srv/gbrain-home/.probe-credentials.json',
    tokenTtl: '300',
  }, { json: true });

  assertOk(spec, r);
  const body = r.json as { status?: string; grant?: { clientId?: string } } | null;
  expect(body?.status).toBe('granted');
  expect(body?.grant?.clientId).toBeTruthy();

  // Credentials go to a file, never to stdout in the clear.
  const f = await composeExec('gbrain-ops', ['test', '-s', '/srv/gbrain-home/.probe-credentials.json']);
  expect(f.exitCode).toBe(0);
});

// Honesty rule 5: mcp verify exit 2 means 'partial' — server stages passed but
// harness evidence is missing. Slice 2 must never render that green.
test('mcp verify exit codes are captured, with 2 meaning partial', async () => {
  const spec = OPERATIONS['mcp.verify']!;
  const r = await execOperation(spec, { client: 'generic' }, { json: true });
  expect(spec.okExitCodes).toContain(0);
  expect([0, 1, 2]).toContain(r.exitCode);
});
