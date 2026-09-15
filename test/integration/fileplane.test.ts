import { test, expect, beforeAll, afterAll } from 'bun:test';
import { SQL } from 'bun';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let sql: SQL;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bs-fp-'));
  process.env.GBRAIN_HOME = dir;
  sql = new SQL(process.env.CONTROL_DATABASE_URL ?? 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control');
});
afterAll(async () => { await sql.end(); await rm(dir, { recursive: true, force: true }); });

// This is the one property S3 exists to provide, proved directly rather than
// inferred from a correct outcome: contend for the SAME key from several
// concurrent callers, have each record when it enters and leaves the
// critical section, and assert the "currently inside" count never exceeds 1.
// No mocks — real Postgres, real Promise.all. A lock that did nothing would
// let all callers' `active += 1` run before any `active -= 1` (they all hang
// on the same Bun.sleep), so this test fails loudly against a no-op lock and
// only passes when mutual exclusion is real (see task-3-report.md for the
// side-by-side RED/GREEN run against a deliberately neutered lock).
test('withAdvisoryLock enforces mutual exclusion — concurrent callers never overlap', async () => {
  const { withAdvisoryLock } = await import('../../src/ops/lock.ts');

  const key = 'test:mutual-exclusion';
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];

  const caller = (id: number) =>
    withAdvisoryLock(sql, key, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`enter:${id}`);
      // Hold the critical section open long enough that, without real mutual
      // exclusion, the other concurrent callers would have time to also
      // enter while this one is still "inside".
      await Bun.sleep(75);
      order.push(`exit:${id}`);
      active -= 1;
    });

  await Promise.all([caller(1), caller(2), caller(3), caller(4)]);

  expect(maxActive).toBe(1);
  expect(active).toBe(0);
  // Each caller's own enter must be immediately followed by its own exit
  // before the next caller's enter appears anywhere in the interleaving.
  for (let i = 0; i < order.length; i += 2) {
    const id = order[i]!.split(':')[1];
    expect(order[i + 1]).toBe(`exit:${id}`);
  }
});

test('concurrent patches both survive — neither key is lost', async () => {
  const { patchConfig, CONFIG_PATH } = await import('../../src/ops/fileplane.ts');

  await Promise.all([
    patchConfig({ openai_api_key: 'sk-alpha' }, { sql }),
    patchConfig({ anthropic_api_key: 'sk-beta' }, { sql }),
  ]);

  const written = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  expect(written.openai_api_key).toBe('sk-alpha');
  expect(written.anthropic_api_key).toBe('sk-beta');
});

test('config.json is written 0600', async () => {
  const { CONFIG_PATH } = await import('../../src/ops/fileplane.ts');
  const { stat } = await import('node:fs/promises');
  const s = await stat(CONFIG_PATH);
  expect(s.mode & 0o777).toBe(0o600);
});

test('a corrupt config.json is never clobbered', async () => {
  const { patchConfig, CONFIG_PATH } = await import('../../src/ops/fileplane.ts');
  await Bun.write(CONFIG_PATH, '{ truncated');
  await expect(patchConfig({ a: 1 }, { sql })).rejects.toThrow('refusing to overwrite');
  expect(await readFile(CONFIG_PATH, 'utf8')).toBe('{ truncated');
});

test('a schema pack name with a path traversal is rejected', async () => {
  const { writeSchemaPack } = await import('../../src/ops/fileplane.ts');
  await expect(writeSchemaPack('../../etc/passwd', 'x: 1', { sql }))
    .rejects.toThrow('invalid schema pack name');
});
