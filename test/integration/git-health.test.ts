import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRepos } from '../../src/ops/git.ts';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bs-git-'));
  const repo = join(root, 'shared');
  await mkdir(repo, { recursive: true });
  await Bun.spawn(['git', 'init', '-q'], { cwd: repo }).exited;
  await Bun.spawn(['git', 'config', 'user.email', 't@example.test'], { cwd: repo }).exited;
  await Bun.spawn(['git', 'config', 'user.name', 'T'], { cwd: repo }).exited;
  await writeFile(join(repo, 'a.md'), '# A\n');
  await Bun.spawn(['git', 'add', '-A'], { cwd: repo }).exited;
  await Bun.spawn(['git', 'commit', '-qm', 'seed'], { cwd: repo }).exited;
}, 60_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('inspectRepos', () => {
  test('reports a clean repo with no lock', async () => {
    const [r] = await inspectRepos(root);
    expect(r?.sourceId).toBe('shared');
    expect(r?.staleLock).toBe(false);
    expect(r?.uncommittedFiles).toBe(0);
  });

  // The drift that matters: a saved page that is not committed is a page the
  // brain cannot see, and the console must say so.
  test('reports uncommitted drift', async () => {
    await writeFile(join(root, 'shared', 'b.md'), '# B\n');
    const [r] = await inspectRepos(root);
    expect(r?.uncommittedFiles).toBeGreaterThan(0);
  });

  test('reports a stale index.lock', async () => {
    const lock = join(root, 'shared', '.git', 'index.lock');
    await writeFile(lock, '');
    const old = new Date(Date.now() - 600_000);
    const { utimes } = await import('node:fs/promises');
    await utimes(lock, old, old);
    const [r] = await inspectRepos(root);
    expect(r?.staleLock).toBe(true);
    expect(r?.lockAgeSeconds).toBeGreaterThan(120);
  });

  test('an empty root yields no repos rather than throwing', async () => {
    expect(await inspectRepos(join(root, 'does-not-exist'))).toEqual([]);
  });
});
