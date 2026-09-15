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
  // One source to scope clients against. Work Item D: `sources add --path`
  // requires a git-initialized repo with a committed file, not a bare dir.
  await seedGitSource('shared');
  await seedGitSource('customers');
  assertOk(OPERATIONS['sources.add']!, await execOperation(OPERATIONS['sources.add']!, {
    id: 'shared', path: '/srv/brain-repos/shared', name: 'Shared company wiki',
  }));
  assertOk(OPERATIONS['sources.add']!, await execOperation(OPERATIONS['sources.add']!, {
    id: 'customers', path: '/srv/brain-repos/customers', name: 'Customer notes',
  }));
}, 900_000);
afterAll(async () => { await composeDown(); }, 120_000);

// Plan defect: `rescope-client <client_id>` looks clients up by the real
// generated client_id (readClientGrant in gbrain's reference source), never
// by the human-readable --name given at registration. Captured from the
// register-client test below and reused by the rescope tests.
let aliceClientId = '';

// V2: the control lane is machine-readable — --json, no screen-scraping.
test('auth clients --json emits a JSON array', async () => {
  const r = await execOperation(OPERATIONS['auth.clients']!, {}, { json: true });
  assertOk(OPERATIONS['auth.clients']!, r);
  expect(r.json).not.toBeNull();
});

test('register-client accepts the tutorial flag set and prints credentials', async () => {
  const spec = OPERATIONS['auth.registerClient']!;
  const r = await execOperation(spec, {
    name: 'alice-example',
    grantTypes: 'client_credentials',
    // Space-separated and quoted: the OAuth wire format. A comma-separated
    // list is rejected at registration.
    scopes: 'read write',
    source: 'customers',
    federatedRead: ['customers', 'shared'],
  });
  assertOk(spec, r);
  // Plan defect: the plan expected a `client_id`-shaped token in stdout, but
  // register-client's real (non-JSON) output is prose: "Client ID:" with a
  // space, not an underscore.
  expect(r.stdout).toMatch(/client[ _]id/i);
  const m = /Client ID:\s+(\S+)/.exec(r.stdout);
  expect(m).not.toBeNull();
  aliceClientId = m![1]!;
});

// V7: --token-ttl is bounded 60s..90d (TOKEN_TTL_MIN_SECONDS=60).
test('register-client rejects a token-ttl below the 60s floor', async () => {
  const r = await execOperation(OPERATIONS['auth.registerClient']!, {
    name: 'ttl-floor-probe', grantTypes: 'client_credentials', scopes: 'read',
    source: 'shared', tokenTtl: '30',
  });
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(/--token-ttl must be an integer number of seconds between 60/);
});

test('register-client accepts a token-ttl inside the bounds', async () => {
  const spec = OPERATIONS['auth.registerClient']!;
  assertOk(spec, await execOperation(spec, {
    name: 'ttl-ok-probe', grantTypes: 'client_credentials', scopes: 'read',
    source: 'shared', tokenTtl: '300',
  }));
});

/**
 * Plan defect (Work Item E, 2026-09-14): the plan expected
 * `auth rescope-client --dry-run --json` to preview without mutating (V2).
 * `rescopeClient`'s own handler DOES implement --dry-run (gbrain's read-only
 * reference src/cli.ts:833 usage string and :848 dispatch), but gbrain
 * 0.50.0.0 validates flags against a pre-dispatch, per-COMMAND (not
 * per-subcommand) static allowlist (src/core/cli-flag-registry.generated.ts)
 * before the handler ever runs, and that allowlist's 'auth' entry omits
 * '--dry-run' — so every `gbrain auth <anything> --dry-run` is rejected
 * with "unknown flag --dry-run for 'gbrain auth'" regardless of subcommand.
 * `--json` alone is in the allowlist and works. This is a confirmed upstream
 * bug, not a registry mistake: `auth.rescopeClient.supportsDryRun` is set to
 * false to match OBSERVED reality (Slice 1/2 must not build the rescope
 * confirm screen on a dry-run preview at this pinned version — see
 * docs/slice-0-findings.md V2).
 */
test('rescope-client --json emits parseable JSON (real mutation, no dry-run)', async () => {
  expect(aliceClientId).not.toBe(''); // depends on the register-client test above
  const spec = OPERATIONS['auth.rescopeClient']!;
  const r = await execOperation(spec, {
    id: aliceClientId, federatedRead: ['customers', 'shared'], boundSlugPrefixes: 'alice-example/',
  }, { json: true });
  assertOk(spec, r);
  expect(r.json).not.toBeNull();
});

test('auth --dry-run is rejected pre-dispatch at this pinned version (upstream bug)', async () => {
  const r = await composeExec('gbrain-ops', [
    'gbrain', 'auth', 'rescope-client', 'alice-example', '--dry-run', '--json',
  ]);
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(/unknown flag --dry-run for 'gbrain auth'/);
});
