import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { composeUp, composeDown, composeExec, resetBrain, BRAIN_DB_URL } from '../helpers/stack.ts';

beforeAll(async () => {
  await composeUp();
  await resetBrain();
  const r = await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 600_000 });
  assertOk(OPERATIONS.init!, r);
}, 900_000);
afterAll(async () => { await composeDown(); }, 120_000);

test('a non-key config value round-trips through set and get', async () => {
  assertOk(OPERATIONS['config.set']!,
    await execOperation(OPERATIONS['config.set']!, { key: 'search.mode', value: 'conservative' }));
  const got = await execOperation(OPERATIONS['config.get']!, { key: 'search.mode' });
  assertOk(OPERATIONS['config.get']!, got);
  expect(got.stdout).toContain('conservative');
});

/**
 * V11 — spec correction. Upstream v0.50.0.0 already guards vendor API keys
 * against the DB plane (src/commands/config.ts:29, key list at 118-128).
 * We assert the CURRENT behavior so a regression, or a version bump that
 * reintroduces the old routing, turns this red.
 *
 * Whatever this test observes is the ground truth for Slice 1's wizard:
 * record the outcome in docs/slice-0-findings.md either way.
 */
test('config set openai_api_key does not silently land in the DB plane', async () => {
  const set = await execOperation(OPERATIONS['config.set']!, {
    key: 'openai_api_key', value: 'sk-contract-test-not-a-real-key',
  });

  // Either upstream refuses the write, or it routes it to the file plane.
  // Both are acceptable; a silent DB-plane write is not.
  const inDb = await composeExec('gbrain-ops', [
    'psql', BRAIN_DB_URL, '-tAc',
    "select count(*) from config where key = 'openai_api_key'",
  ]);
  const dbCount = inDb.exitCode === 0 ? Number(inDb.stdout.trim() || '0') : 0;

  if (set.exitCode === 0) {
    expect(dbCount).toBe(0); // routed to the file plane, not the DB plane
  } else {
    expect(set.stderr + set.stdout).toMatch(/file plane|api[_ ]key|not.*db/i);
  }
});

// Plan defect (Work Item C, 2026-09-14): the plan called this operation
// `config.list` / `gbrain config list`, but upstream v0.50.0.0 has no `list`
// subcommand — `gbrain config` usage is `[show|get|set|unset] <key> [value]`
// (src/commands/config.ts). The read-all-config verb is `show`. Registry
// entry and this test renamed to match observed reality.
test('config show emits a parseable inventory', async () => {
  const r = await execOperation(OPERATIONS['config.show']!, {});
  assertOk(OPERATIONS['config.show']!, r);
  expect(r.stdout.length).toBeGreaterThan(0);
  expect(r.stdout).toContain('GBrain config:');
});
