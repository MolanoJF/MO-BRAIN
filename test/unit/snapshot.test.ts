import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dockerVolumeDriver, dumpDatabase, tarVolumeToFile,
  SNAPSHOT_DATABASES, SNAPSHOT_VOLUMES,
} from '../../src/upgrade/snapshot.ts';
import type { Runner, RunResult } from '../../src/upgrade/snapshot.ts';

/** Records every argv it is asked to run — no Docker, no Postgres. */
class FakeRunner implements Runner {
  calls: string[][] = [];
  async run(argv: string[]): Promise<RunResult> {
    this.calls.push(argv);
    // A real `docker run … busybox tar cf /out/<f>` writes the archive into the
    // bind-mounted out dir. The fake must perform that side effect, or take()'s
    // buildManifest finds no volume archive to hash. The host out dir is the
    // argv token ending in ':/out' (tarVolumeToFile's `-v ${outDir}:/out`).
    const outMount = argv.find((a) => a.endsWith(':/out'));
    const cf = argv.lastIndexOf('cf');
    if (outMount && cf >= 0 && argv[cf + 1]?.startsWith('/out/')) {
      await writeFile(
        join(outMount.slice(0, -':/out'.length), argv[cf + 1]!.slice('/out/'.length)),
        `fake tar for: ${argv.join(' ')}`,
      );
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  async captureToFile(argv: string[], outPath: string): Promise<void> {
    this.calls.push(argv);
    await writeFile(outPath, `fake output for: ${argv.join(' ')}`);
  }
  async feedFile(argv: string[]): Promise<RunResult> {
    this.calls.push(argv);
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

const COMPOSE = ['docker', 'compose', '-f', 'compose/docker-compose.yml'];

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bs-snap-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('SNAPSHOT_DATABASES / SNAPSHOT_VOLUMES', () => {
  test('name exactly what D3 promises', () => {
    expect(SNAPSHOT_DATABASES).toEqual(['gbrain', 'control']);
    expect(SNAPSHOT_VOLUMES).toEqual(['brainstand_brain-repos', 'brainstand_gbrain-home']);
  });
});

describe('the exact argv for each artifact', () => {
  test('dumpDatabase runs pg_dump through compose exec postgres, never a shell string', async () => {
    const runner = new FakeRunner();
    await dumpDatabase(runner, COMPOSE, 'gbrain', join(dir, 'brain.sql'));
    expect(runner.calls).toEqual([
      [...COMPOSE, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'gbrain', '-d', 'gbrain'],
    ]);
  });

  test('tarVolumeToFile uses a throwaway busybox container, never `compose exec` into a service', async () => {
    const runner = new FakeRunner();
    await tarVolumeToFile(runner, 'brainstand_gbrain-home', dir, 'gbrain-home.tar');
    expect(runner.calls).toEqual([[
      'docker', 'run', '--rm',
      '-v', 'brainstand_gbrain-home:/src:ro', '-v', `${dir}:/out`,
      'busybox', 'tar', 'cf', '/out/gbrain-home.tar', '-C', '/src', '.',
    ]]);
    expect(runner.calls[0]!.join(' ')).not.toMatch(/gbrain-serve|gbrain-worker|gbrain-ops/);
  });

  test('take() produces all four named artifacts through those two primitives only', async () => {
    const runner = new FakeRunner();
    const manifest = await dockerVolumeDriver.take(
      { runId: 'run-1', volumes: SNAPSHOT_VOLUMES, databases: SNAPSHOT_DATABASES, outDir: dir, compose: COMPOSE },
      runner,
    );
    expect(manifest.artifacts.map((a) => a.name).sort()).toEqual(
      ['brain-db', 'brain-repos', 'control-db', 'gbrain-home'],
    );
    expect(manifest.driver).toBe('docker-volume');
    expect(manifest.runId).toBe('run-1');
    expect(runner.calls.filter((c) => c.includes('pg_dump'))).toHaveLength(2);
    const tarCalls = runner.calls.filter((c) => c[0] === 'docker' && c[1] === 'run');
    expect(tarCalls).toHaveLength(2);
    // D3: the volume half never needs a running service — a throwaway
    // container only, so the driver works with everything stopped.
    for (const c of tarCalls) expect(c.join(' ')).not.toMatch(/exec -T gbrain/);
  });
});

describe('verify and restore', () => {
  test('verify fails on a sha mismatch', async () => {
    const runner = new FakeRunner();
    const manifest = await dockerVolumeDriver.take(
      { runId: 'run-2', volumes: SNAPSHOT_VOLUMES, databases: SNAPSHOT_DATABASES, outDir: dir, compose: COMPOSE },
      runner,
    );
    const corrupted = {
      ...manifest,
      artifacts: manifest.artifacts.map((a) =>
        a.name === 'brain-db' ? { ...a, sha256: '0'.repeat(64) } : a),
    };
    expect(await dockerVolumeDriver.verify(corrupted)).toBe(false);
  });

  test('restore refuses a manifest that does not verify, before it runs a single command', async () => {
    const runner = new FakeRunner();
    const ctx = { runId: 'run-3', volumes: SNAPSHOT_VOLUMES, databases: SNAPSHOT_DATABASES, outDir: dir, compose: COMPOSE };
    const manifest = await dockerVolumeDriver.take(ctx, runner);
    const corrupted = {
      ...manifest,
      artifacts: manifest.artifacts.map((a) =>
        a.name === 'control-db' ? { ...a, sha256: '0'.repeat(64) } : a),
    };
    const restoreRunner = new FakeRunner();
    await expect(dockerVolumeDriver.restore(ctx, corrupted, restoreRunner))
      .rejects.toThrow(/verification failed/);
    expect(restoreRunner.calls).toHaveLength(0);
  });

  test('describe() lists the four production artifact names with zero I/O', () => {
    expect(dockerVolumeDriver.describe().map((a) => a.name).sort()).toEqual(
      ['brain-db', 'brain-repos', 'control-db', 'gbrain-home'],
    );
  });
});
