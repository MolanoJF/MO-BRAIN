import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import { writeReport } from '../../src/ops/reports.ts';

const ACTOR = { name: 'Ada Member', email: 'ada@example.test' };
let sql: SQL;
let root: string;

const git = async (cwd: string, args: string[]) => {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return out.trim();
};

beforeAll(async () => {
  sql = new SQL(process.env.CONTROL_DATABASE_URL!);
  root = await mkdtemp(join(tmpdir(), 'bs-repos-'));
  for (const id of ['space-a', 'space-b']) {
    const dir = join(root, id);
    await mkdir(dir, { recursive: true });
    await git(dir, ['init']);
    await Bun.write(join(dir, 'README.md'), `# ${id}\n`);
    await git(dir, ['add', '-A']);
    await git(dir, ['-c', 'user.email=seed@x', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  }
});

afterAll(async () => { await sql.end(); });

describe('ops report writes', () => {
  test('lands at the upstream path and is committed as the member', async () => {
    const r = await writeReport(
      { sourceId: 'space-a', job: 'live-sync', stamp: '2026-09-15-0230', body: '# ok\n', actor: ACTOR },
      { sql, root },
    );
    expect(r.relPath).toBe('reports/live-sync/2026-09-15-0230.md');
    expect(r.committed).toBe(true);
    expect(await readFile(join(root, 'space-a', r.relPath), 'utf8')).toBe('# ok\n');
    expect(await git(join(root, 'space-a'), ['log', '-1', '--format=%an <%ae>']))
      .toBe('Ada Member <ada@example.test>');
    // Sync imports COMMITS, not the working tree: nothing may be left dirty.
    expect(await git(join(root, 'space-a'), ['status', '--porcelain'])).toBe('');
  });

  test('a repeated stamp never overwrites', async () => {
    const again = await writeReport(
      { sourceId: 'space-a', job: 'live-sync', stamp: '2026-09-15-0230', body: '# second\n', actor: ACTOR },
      { sql, root },
    );
    expect(again.relPath).toBe('reports/live-sync/2026-09-15-0230-2.md');
    expect(await readFile(join(root, 'space-a', 'reports/live-sync/2026-09-15-0230.md'), 'utf8'))
      .toBe('# ok\n');
  });

  test('concurrent writes to one Space both land and both commit', async () => {
    const [a, b] = await Promise.all([
      writeReport({ sourceId: 'space-b', job: 'job-a', stamp: '2026-09-15-0300', body: 'a\n', actor: ACTOR }, { sql, root }),
      writeReport({ sourceId: 'space-b', job: 'job-b', stamp: '2026-09-15-0300', body: 'b\n', actor: ACTOR }, { sql, root }),
    ]);
    expect(a.relPath).not.toBe(b.relPath);
    expect(a.committed || b.committed).toBe(true);
    expect(await git(join(root, 'space-b'), ['status', '--porcelain'])).toBe('');
  });
});
