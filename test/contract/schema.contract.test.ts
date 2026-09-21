import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { parseSchemaActiveProse } from '../../src/contracts/capability.ts';
import { composeUp, composeDown, composeExec, resetBrain, BRAIN_DB_URL } from '../helpers/stack.ts';

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

test('schema.show resolves through the env tier, not the raw manifest', async () => {
  // S4 regression fence: the POSITIONAL form `schema show <pack>` returns the
  // UNRESOLVED manifest — gbrain-creator would report 1 page type. The env
  // tier with no positional routes through gbrain's own resolver and yields
  // 27. If anyone ever switches this entry back to a positional pack name,
  // this assertion breaks. See docs/schema-pack-findings.md S4.
  const creator = await execOperation(OPERATIONS['schema.show']!, {}, {
    json: true, env: { GBRAIN_SCHEMA_PACK: 'gbrain-creator' },
  });
  assertOk(OPERATIONS['schema.show']!, creator);
  const c = creator.json as { page_types?: unknown[] } | null;
  expect(c?.page_types?.length).toBe(27);

  const base = await execOperation(OPERATIONS['schema.show']!, {}, {
    json: true, env: { GBRAIN_SCHEMA_PACK: 'gbrain-base' },
  });
  assertOk(OPERATIONS['schema.show']!, base);
  const b = base.json as { page_types?: unknown[] } | null;
  expect(b?.page_types?.length).toBe(27);
}, 120_000);

test('config.unset clears a per-source pack override written by config.set --force', async () => {
  // The tier-3 key is NOT in gbrain's KNOWN_CONFIG_KEY_PREFIXES, so a plain
  // `config set` exits 1 on the unknown-key gate (S1/S6 probe 1). This is the
  // regression fence for the `force` param.
  const key = 'schema_pack.source.zz-contract-probe';
  const noForce = await execOperation(OPERATIONS['config.set']!, { key, value: 'gbrain-investor' });
  expect(noForce.exitCode).toBe(1);
  expect(noForce.stdout + noForce.stderr).toMatch(/Unknown config key/);

  const set = await execOperation(OPERATIONS['config.set']!, { key, value: 'gbrain-investor', force: true });
  assertOk(OPERATIONS['config.set']!, set);

  const got = await execOperation(OPERATIONS['config.get']!, { key });
  assertOk(OPERATIONS['config.get']!, got);
  expect(got.stdout).toContain('gbrain-investor');

  // config.unset clears it; the key then answers exit 1 with `Config key not
  // found` (S6 probe 5). We never touch the brain-wide active pack.
  const unset = await execOperation(OPERATIONS['config.unset']!, { key });
  assertOk(OPERATIONS['config.unset']!, unset);

  const after = await execOperation(OPERATIONS['config.get']!, { key });
  expect(after.exitCode).toBe(1);
  expect(after.stdout + after.stderr).toMatch(/Config key not found/);
}, 120_000);

// Grammar coverage only: the registry marks `id` required, so a true no-arg
// call cannot be built by buildArgv. Run the bare verbs through composeExec and
// assert gbrain's own usage refusal (exit 2). No source is fabricated.
test('sources remove/archive/rename with no argument exit 2 with usage', async () => {
  const cases = [
    ['sources.remove', 'remove'],
    ['sources.archive', 'archive'],
    ['sources.rename', 'rename'],
  ] as const;
  for (const [id, verb] of cases) {
    const spec = OPERATIONS[id]!;
    expect(spec.argv).toEqual(['sources', verb]);
    const r = await composeExec('gbrain-ops', ['gbrain', ...spec.argv]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/usage:/i);
  }
}, 120_000);
