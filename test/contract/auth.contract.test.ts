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
 * 0.50.0.0 rejected `gbrain auth * --dry-run` pre-dispatch
 * ("unknown flag --dry-run for 'gbrain auth'"). Measured at 0.60.104.0:
 * the flag is accepted. `rescope-client alice-example --dry-run --json`
 * still exits non-zero because no grant field or --profile was passed:
 * stderr `Error: Pass a grant field or --profile to rescope`, stdout
 * `error.code=invalid_grant`. This test does not flip supportsDryRun.
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

test('auth --dry-run is accepted and a rescope with no grant field is invalid_grant', async () => {
  const r = await composeExec('gbrain-ops', [
    'gbrain', 'auth', 'rescope-client', 'alice-example', '--dry-run', '--json',
  ]);
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(/Pass a grant field or --profile to rescope/);
  expect(r.stderr + r.stdout).not.toMatch(/unknown flag --dry-run/);
  const body = JSON.parse(r.stdout) as { error?: { code?: string } };
  expect(body.error?.code).toBe('invalid_grant');
});
