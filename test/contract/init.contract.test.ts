import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { composeUp, composeDown, composeExec, resetBrain, BRAIN_DB_URL } from '../helpers/stack.ts';

beforeAll(async () => { await composeUp(); await resetBrain(); }, 300_000);
afterAll(async () => { await composeDown(); }, 120_000);

// V3: --non-interactive exists and requires --url or GBRAIN_DATABASE_URL.
test('init --non-interactive without a url fails with the documented message', async () => {
  const r = await composeExec('gbrain-ops', ['gbrain', 'init', '--non-interactive'], {
    env: { GBRAIN_DATABASE_URL: '' },
  });
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr + r.stdout).toContain('--non-interactive requires --url');
});

// V3 + V4: the only interactive fork is embedding-provider selection, and
// --non-interactive plus an explicit --embedding-model resolves it.
test('init --non-interactive succeeds headlessly against postgres', async () => {
  const spec = OPERATIONS.init!;
  const r = await execOperation(spec, {
    nonInteractive: true,
    force: true,
    url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 600_000 });

  assertOk(spec, r);
  // Never block on a TTY: a prompt would hang until our timeout killed it.
  expect(r.stderr).not.toMatch(/\?\s|\(y\/n\)|press enter/i);
}, 660_000);

test('init created gbrain tables in the brain database', async () => {
  const r = await composeExec('gbrain-ops', [
    'psql', BRAIN_DB_URL, '-tAc',
    "select count(*) from information_schema.tables where table_schema='public'",
  ]);
  expect(r.exitCode).toBe(0);
  expect(Number(r.stdout.trim())).toBeGreaterThan(20);
});

// V4: the search-mode cost matrix is a POST-init config set, not part of init.
test('search.mode is settable after init, not during it', async () => {
  const spec = OPERATIONS['config.set']!;
  const r = await execOperation(spec, { key: 'search.mode', value: 'fast' });
  assertOk(spec, r);
});

// The redacted argv must never carry the connection string into a log.
test('the returned argv redacts the database url', async () => {
  const spec = OPERATIONS.init!;
  const r = await execOperation(spec, {
    nonInteractive: true, url: BRAIN_DB_URL, embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 60_000 }).catch((e) => { throw e; });
  expect(r.argv.join(' ')).not.toContain(BRAIN_DB_URL);
  expect(r.argv).toContain('***REDACTED***');
}, 90_000);
