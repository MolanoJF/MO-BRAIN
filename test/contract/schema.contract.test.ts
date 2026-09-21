import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { parseSchemaActiveProse } from '../../src/contracts/capability.ts';
import { composeUp, composeDown, resetBrain, BRAIN_DB_URL } from '../helpers/stack.ts';

beforeAll(async () => {
  await composeUp();
  await resetBrain();
  // Pin the pack at init: this is both the setup AND the assertion target for
  // the `--schema-pack` contract test below.
  const r = await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
    schemaPack: 'gbrain-base',
  }, { timeoutMs: 600_000 });
  assertOk(OPERATIONS.init!, r);
}, 900_000);
afterAll(async () => { await composeDown(); }, 120_000);

test('init --schema-pack is accepted and actually selects the pack', async () => {
  // The flag is undocumented in `gbrain init --help` but allowlisted. If a
  // version bump ever drops it, init would exit 2 on an unknown flag and
  // beforeAll's assertOk would have already failed — this asserts the EFFECT.
  const active = await execOperation(OPERATIONS['schema.active']!, {});
  assertOk(OPERATIONS['schema.active']!, active);
  expect(parseSchemaActiveProse(active.stdout).pack).toBe('gbrain-base');
});

test('schema active reports the resolution tier, and ignores --json', async () => {
  const r = await execOperation(OPERATIONS['schema.active']!, {});
  assertOk(OPERATIONS['schema.active']!, r);
  const a = parseSchemaActiveProse(r.stdout);
  expect(a.pack).toBeTruthy();
  // init writes ~/.gbrain/config.json, which is tier 6.
  expect(a.source).toBe('home-config');
  expect(a.pageTypes).toBeGreaterThan(0);

  // The registry must keep refusing --json: the command accepts and ignores it.
  expect(() => buildArgv(OPERATIONS['schema.active']!, {}, { json: true }))
    .toThrow(/does not support --json/);
});

test('schema validate accepts a bundled pack name as a positional', async () => {
  const r = await execOperation(OPERATIONS['schema.validate']!, { packName: 'gbrain-recommended' });
  assertOk(OPERATIONS['schema.validate']!, r);
  expect(r.stdout).toContain('valid manifest');
});

test('schema validate exits 1 on an unknown pack', async () => {
  const r = await execOperation(OPERATIONS['schema.validate']!, { packName: 'no-such-pack-xyz' });
  expect(r.exitCode).toBe(1);
  expect(r.stdout + r.stderr).toMatch(/Unknown pack/i);
});

test('schema lint still needs the pack name BEFORE --with-db', async () => {
  // Regression fence for Work Item S: `--with-db` with no positional is
  // swallowed as positional[0] and answers `Pack not found: --with-db`.
  // buildArgv emits params in array order, so packName must stay listed first.
  const argv = buildArgv(OPERATIONS['schema.lint']!, { packName: 'gbrain-base', withDb: true }, { json: true });
  expect(argv).toEqual(['schema', 'lint', 'gbrain-base', '--with-db', '--json']);
});

test('schema sync previews without --apply and still refuses --dry-run', async () => {
  const r = await execOperation(OPERATIONS['schema.sync']!, {}, { json: true });
  assertOk(OPERATIONS['schema.sync']!, r);
  const body = r.json as { apply: boolean; total_applied: number } | null;
  expect(body?.apply).toBe(false);
  expect(body?.total_applied).toBe(0);

  expect(() => buildArgv(OPERATIONS['schema.sync']!, {}, { dryRun: true }))
    .toThrow(/does not support --dry-run/);
});
