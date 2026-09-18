/**
 * Task 8, the workspace seam (D5, P5).
 *
 * P5 measured the container's minimal writable set: `/tmp` ALONE. The rootfs is
 * read-only, `/tmp` is a tmpfs, so a directory under `/tmp/agent-run/` is
 * ephemeral by construction — it dies with the container, and it is never a bind
 * mount of `GBRAIN_HOME` or of a brain repo. There is no `/workspace` tmpfs.
 *
 * These tests use an explicit root under `.brainstand-tmp/slice4/` so they can
 * run on the host (win32 here, Linux in the container) without writing to `/tmp`.
 */
import { test, expect, describe, afterAll } from 'bun:test';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  WORKSPACE_ROOT, workspacePath, createWorkspace, destroyWorkspace,
} from '../../src/runner/workspace.ts';

const ROOT = join(import.meta.dir, '..', '..', '.brainstand-tmp', 'slice4', 'Task8RunnerProcess', 'ws');

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('workspacePath', () => {
  // D5/Task 3, measured in P5: the per-run workspace lives under /tmp, and there
  // is no /workspace tmpfs to put it in.
  test('the container root is /tmp/agent-run, never /workspace', () => {
    expect(WORKSPACE_ROOT).toBe('/tmp/agent-run');
  });

  test('a run\'s workspace is one directory named for its run id', () => {
    expect(workspacePath('run-1', ROOT)).toBe(join(ROOT, 'run-1'));
  });

  test('an id that could escape the root is refused, not sanitised', () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', '', '.', '..', '.hidden', 'a\u0000b']) {
      expect(() => workspacePath(bad, ROOT)).toThrow('invalid runId');
      expect(() => workspacePath(bad, ROOT)).toThrow('invalid runId');
    }
  });
});

describe('createWorkspace / destroyWorkspace', () => {
  test('creates the run directory and leaves nothing in it', async () => {
    const path = await createWorkspace('run-create', ROOT);
    expect(path).toBe(join(ROOT, 'run-create'));
    expect((await stat(path)).isDirectory()).toBe(true);
    expect(await readdir(path)).toEqual([]);
    await destroyWorkspace('run-create', ROOT);
  });

  // Never reused: a second create for the same run id is a bug, and reusing a
  // directory would leave a previous run's files inside it.
  test('refuses to reuse an existing run directory', async () => {
    await createWorkspace('run-reuse', ROOT);
    await expect(createWorkspace('run-reuse', ROOT)).rejects.toThrow('already exists');
    await destroyWorkspace('run-reuse', ROOT);
  });

  test('destroys recursively and leaves the root itself alone', async () => {
    const path = await createWorkspace('run-destroy', ROOT);
    await mkdir(join(path, 'nested'), { recursive: true });
    await Bun.write(join(path, 'nested', 'file.txt'), 'x');
    await destroyWorkspace('run-destroy', ROOT);
    expect(await Bun.file(join(path, 'nested', 'file.txt')).exists()).toBe(false);
    expect((await stat(ROOT)).isDirectory()).toBe(true);
  });

  // Every exit path calls destroy, including the one after a throw, so a second
  // call and a call for a run that never started must both be no-ops.
  test('is idempotent', async () => {
    await createWorkspace('run-idem', ROOT);
    await destroyWorkspace('run-idem', ROOT);
    await destroyWorkspace('run-idem', ROOT);
    await destroyWorkspace('run-never-created', ROOT);
  });

  test('destroys only its own run directory', async () => {
    await createWorkspace('run-a', ROOT);
    await createWorkspace('run-b', ROOT);
    await destroyWorkspace('run-a', ROOT);
    expect((await stat(join(ROOT, 'run-b'))).isDirectory()).toBe(true);
    expect(await readdir(join(ROOT, 'run-b'))).toEqual([]);
    await destroyWorkspace('run-b', ROOT);
  });

  test('destroy refuses an id that could escape the root', async () => {
    await createWorkspace('run-guard', ROOT);
    await expect(destroyWorkspace('../run-guard', ROOT)).rejects.toThrow('invalid runId');
    expect((await stat(join(ROOT, 'run-guard'))).isDirectory()).toBe(true);
    await destroyWorkspace('run-guard', ROOT);
  });

  test('create and destroy leave nothing behind', async () => {
    await rm(ROOT, { recursive: true, force: true });
    await createWorkspace('run-clean', ROOT);
    await destroyWorkspace('run-clean', ROOT);
    expect(await readdir(ROOT)).toEqual([]);
  });
});
