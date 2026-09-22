import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { composeUp, composeDown, composeExec, resetBrain, BRAIN_DB_URL } from '../helpers/stack.ts';

const PACK = `zz-contract-${Date.now().toString(36)}`;

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

afterAll(async () => {
  await composeExec('gbrain-ops', ['sh', '-c', `rm -rf /srv/gbrain-home/.gbrain/schema-packs/${PACK}`]);
  await composeDown();
}, 120_000);

test("'schema.fork' copies a bundled pack under a new name", async () => {
  expect(buildArgv(OPERATIONS['schema.fork']!, { from: 'gbrain-base-v2', to: PACK }, { json: true }))
    .toEqual(['schema', 'fork', 'gbrain-base-v2', PACK, '--json']);
  const r = await execOperation(OPERATIONS['schema.fork']!, { from: 'gbrain-base-v2', to: PACK }, { json: true });
  assertOk(OPERATIONS['schema.fork']!, r);
  expect(JSON.parse(r.stdout).to).toBe(PACK);
});

test("'schema.showRaw' prints the pack's own declarations", async () => {
  const r = await execOperation(OPERATIONS['schema.showRaw']!, { packName: PACK }, { json: true });
  assertOk(OPERATIONS['schema.showRaw']!, r);
  expect(JSON.parse(r.stdout).name).toBe(PACK);
});

test("'schema.mutate' applies a batch atomically, and a failed batch changes nothing", async () => {
  const ok = JSON.stringify({ pack: PACK, mutations: [
    { op: 'add_type', name: 'contract', primitive: 'entity', prefix: 'contracts/' },
  ] });
  const r = await execOperation(OPERATIONS['schema.mutate']!, { payload: ok });
  assertOk(OPERATIONS['schema.mutate']!, r);
  expect(JSON.parse(r.stdout).mutations_applied).toBe(1);

  const bad = JSON.stringify({ pack: PACK, mutations: [
    { op: 'add_type', name: 'x', primitive: 'entity', prefix: 'x/' },
    { op: 'remove_type', name: 'does-not-exist' },
  ] });
  const f = await execOperation(OPERATIONS['schema.mutate']!, { payload: bad });
  const body = JSON.parse(f.stdout);
  expect(body.error).toBe('mutation_failed');
  expect(body.pack_unchanged).toBe(true);
  const show = await execOperation(OPERATIONS['schema.showRaw']!, { packName: PACK }, { json: true });
  expect(JSON.parse(show.stdout).page_types.some((t: { name: string }) => t.name === 'x')).toBe(false);
});
