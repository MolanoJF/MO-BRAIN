import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { SQL } from 'bun';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const CONTROL_DATABASE_URL =
  process.env.CONTROL_DATABASE_URL ?? 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

const SCRATCH_PG_CMD =
  'docker run -d --name bs-fp-pg -e POSTGRES_USER=gbrain -e POSTGRES_PASSWORD=ci-not-a-real-secret ' +
  '-e POSTGRES_DB=control -p 5432:5432 pgvector/pgvector:pg16';

const SKIP_ENV = 'BRAINSTAND_ALLOW_SKIP_SEED_SPACE';

async function probePostgres(): Promise<boolean> {
  const probe = new SQL(CONTROL_DATABASE_URL, { connectionTimeout: 3, max: 1 });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
}

const postgresAvailable = await probePostgres();

let reposDir: string;
let sql: SQL;

beforeAll(async () => {
  reposDir = await mkdtemp(join(tmpdir(), 'bs-seed-'));
  process.env.BRAIN_REPOS = reposDir;
  sql = new SQL(CONTROL_DATABASE_URL);
});

afterAll(async () => {
  if (sql) await sql.end();
  if (reposDir) await rm(reposDir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout }));
  });
}

describe('seedSpaceRepo', () => {
  test('seed-space tests are not silently skipped', () => {
    if (postgresAvailable) return;
    if (process.env[SKIP_ENV] === '1') return;
    throw new Error(
      `Could not reach Postgres at ${CONTROL_DATABASE_URL}, so seedSpaceRepo tests were skipped. ` +
        `Start scratch Postgres:\n\n  ${SCRATCH_PG_CMD}\n\nOr set ${SKIP_ENV}=1 to opt out explicitly.`,
    );
  });

  test('fileplane seed uses argv-array git spawn, never a shell string', async () => {
    const src = await readFile('src/ops/fileplane.ts', 'utf8');
    expect(src).toMatch(/spawn\(\s*['"]git['"]\s*,/);
    expect(src).not.toMatch(/spawn\(\s*['"]sh['"]/);
    expect(src).not.toMatch(/spawn\(\s*['"]bash['"]/);
    // Identity and commit must be argv elements, not `sh -c "git ..."`.
    expect(src).toMatch(/'-c',\s*'user\.email=/);
    expect(src).toMatch(/'-c',\s*'user\.name=/);
    expect(src).not.toMatch(/sh\s*-c/);
  });

  test.skipIf(!postgresAvailable)('rejects a path-traversal / invalid sourceId', async () => {
    const { seedSpaceRepo } = await import('../../src/ops/fileplane.ts');
    await expect(seedSpaceRepo('../etc', { sql })).rejects.toThrow(/invalid sourceId/);
    await expect(seedSpaceRepo('Has Caps', { sql })).rejects.toThrow(/invalid sourceId/);
    await expect(seedSpaceRepo('evil/../x', { sql })).rejects.toThrow(/invalid sourceId/);
  });

  test.skipIf(!postgresAvailable)('creates a git repo with at least one committed tracked file', async () => {
    const { seedSpaceRepo } = await import('../../src/ops/fileplane.ts');
    const dir = await seedSpaceRepo('shared', { sql });
    expect(dir).toBe(join(reposDir, 'shared'));
    await access(join(dir, '.git'));
    await access(join(dir, 'README.md'));
    const head = await git(dir, ['rev-parse', 'HEAD']);
    expect(head.exitCode).toBe(0);
    expect(head.stdout.trim().length).toBeGreaterThan(7);
    const tracked = await git(dir, ['ls-files']);
    expect(tracked.stdout).toContain('README.md');
  });

  test.skipIf(!postgresAvailable)('re-seeding the same sourceId is idempotent', async () => {
    const { seedSpaceRepo } = await import('../../src/ops/fileplane.ts');
    await seedSpaceRepo('shared', { sql });
    await seedSpaceRepo('shared', { sql });
    const head = await git(join(reposDir, 'shared'), ['rev-parse', 'HEAD']);
    expect(head.exitCode).toBe(0);
  });
});
