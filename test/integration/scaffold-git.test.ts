import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { SQL } from 'bun';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldFolders } from '../../src/ops/git.ts';

const CONTROL_DATABASE_URL =
  process.env.CONTROL_DATABASE_URL ?? 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

async function probePostgres(): Promise<boolean> {
  const probe = new SQL(CONTROL_DATABASE_URL, { connectionTimeout: 3, max: 1 });
  try { await probe`select 1`; return true; }
  catch { return false; }
  finally { await probe.end().catch(() => {}); }
}

const postgresAvailable = await probePostgres();

const MEMBER = { name: 'Alice Example', email: 'alice@example.test' };

let sql: SQL;

async function gitRun(cwd: string, args: string[]): Promise<void> {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const code = await p.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${await new Response(p.stderr).text()}`);
  }
}

/** A temp repos root, so `scaffoldFolders`'s default cannot touch the real one. */
const tempReposRoot = () => mkdtemp(join(tmpdir(), 'bs-scaffold-'));

async function initRepo(reposRoot: string, sourceId: string): Promise<string> {
  const repo = join(reposRoot, sourceId);
  await mkdir(repo, { recursive: true });
  await gitRun(repo, ['init', '-q']);
  await gitRun(repo, ['config', 'user.email', 't@example.test']);
  await gitRun(repo, ['config', 'user.name', 'T']);
  await writeFile(join(repo, 'README.md'), '# Space\n');
  await gitRun(repo, ['add', '-A']);
  await gitRun(repo, ['commit', '-qm', 'seed']);
  return repo;
}

beforeAll(async () => {
  sql = new SQL(CONTROL_DATABASE_URL);
});
afterAll(async () => {
  if (sql) await sql.end();
});

describe('scaffoldFolders', () => {
  test.skipIf(!postgresAvailable)('creates missing READMEs in one commit and never overwrites', async () => {
    const reposRoot = await tempReposRoot();
    const repo = await initRepo(reposRoot, 'customers');
    await mkdir(join(repo, 'contracts'), { recursive: true });
    await writeFile(join(repo, 'contracts', 'README.md'), 'mine\n');
    await gitRun(repo, ['add', '-A']);
    await gitRun(repo, ['commit', '-qm', 'mine']);

    const r = await scaffoldFolders({
      sourceId: 'customers', actor: MEMBER, message: 'scaffold: legal-ops folders',
      entries: [{ dir: 'contracts/', readme: 'x' }, { dir: 'matters/', readme: '# Matter\n' }],
    }, { sql, root: reposRoot });

    expect(r.created).toEqual(['matters/README.md']);
    expect(r.skipped).toEqual(['contracts/README.md']);
    expect(await readFile(join(repo, 'contracts', 'README.md'), 'utf8')).toBe('mine\n');
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);

    await rm(reposRoot, { recursive: true, force: true });
  }, 60_000);

  test.skipIf(!postgresAvailable)('nothing to create is not a commit', async () => {
    const reposRoot = await tempReposRoot();
    await initRepo(reposRoot, 'customers');
    const r = await scaffoldFolders(
      { sourceId: 'customers', actor: MEMBER, message: 'm', entries: [] },
      { sql, root: reposRoot },
    );
    expect(r).toEqual({ created: [], skipped: [], sha: null });

    await rm(reposRoot, { recursive: true, force: true });
  }, 60_000);

  test.skipIf(!postgresAvailable)('refuses a traversing dir before touching the repo', async () => {
    const reposRoot = await tempReposRoot();
    await initRepo(reposRoot, 'customers');
    await expect(scaffoldFolders({
      sourceId: 'customers', actor: MEMBER, message: 'm',
      entries: [{ dir: '../x/', readme: '' }],
    }, { sql, root: reposRoot })).rejects.toThrow();

    await rm(reposRoot, { recursive: true, force: true });
  }, 60_000);
});
