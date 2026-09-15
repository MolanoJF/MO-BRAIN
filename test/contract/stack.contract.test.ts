import { test, expect, beforeAll, afterAll } from 'bun:test';
import { composeUp, composeDown, composeExec, BRAIN_DB_URL } from '../helpers/stack.ts';
import { parseGbrainVersion } from '../../src/contracts/capability.ts';

const PIN = process.env.GBRAIN_VERSION ?? '0.50.0.0';

beforeAll(async () => { await composeUp(); }, 300_000);
afterAll(async () => { await composeDown(); }, 120_000);

test('the ops container runs the pinned gbrain version', async () => {
  const r = await composeExec('gbrain-ops', ['gbrain', '--version']);
  expect(r.exitCode).toBe(0);
  expect(parseGbrainVersion(r.stdout)).toBe(PIN);
});

test('postgres has vector, pg_trgm and pgcrypto', async () => {
  const r = await composeExec('gbrain-ops', [
    'psql', BRAIN_DB_URL,
    '-tAc', "select extname from pg_extension order by extname",
  ]);
  expect(r.exitCode).toBe(0);
  const names = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  expect(names).toContain('vector');
  expect(names).toContain('pg_trgm');
  expect(names).toContain('pgcrypto');
});

test('GBRAIN_HOME is writable in the ops container', async () => {
  const r = await composeExec('gbrain-ops', ['sh', '-c', 'touch /srv/gbrain-home/.probe && echo ok']);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe('ok');
});
