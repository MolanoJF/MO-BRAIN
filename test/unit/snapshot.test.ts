import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  dockerVolumeDriver, dumpDatabase, tarVolumeToFile, untarFileIntoVolume,
  SNAPSHOT_DATABASES,
  projectName, snapshotVolumes, volumeLabel,
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
beforeEach(async () => {
  // Bun auto-loads a developer's .env, which carries COMPOSE_PROJECT_NAME after
  // an install. Without this reset every volume name below is prefixed and the
  // argv expectations fail; the D4 block sets it explicitly to prove the override.
  delete process.env.COMPOSE_PROJECT_NAME;
  dir = await mkdtemp(join(tmpdir(), 'bs-snap-'));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('SNAPSHOT_DATABASES / snapshotVolumes', () => {
  test('name exactly what D3 promises', () => {
    expect(SNAPSHOT_DATABASES).toEqual(['gbrain', 'control']);
    expect(snapshotVolumes()).toEqual(['mobrain_brain-repos', 'mobrain_gbrain-home']);
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
    await tarVolumeToFile(runner, 'mobrain_gbrain-home', dir, 'gbrain-home.tar');
    const tarArgv = [
      'docker', 'run', '--rm',
      '-v', 'mobrain_gbrain-home:/src:ro', '-v', `${dir}:/out`,
      'busybox', 'tar', 'cf', '/out/gbrain-home.tar', '-C', '/src', '.',
    ];
    // POSIX hosts hand the root-owned artifact back to the invoking user; a
    // host with no getuid (Windows) has nothing to chown.
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    expect(runner.calls).toEqual(uid !== undefined && gid !== undefined
      ? [tarArgv, [
        'docker', 'run', '--rm', '-v', `${dir}:/out`,
        'busybox', 'chown', `${uid}:${gid}`, '/out/gbrain-home.tar',
      ]]
      : [tarArgv]);
    expect(runner.calls[0]!.join(' ')).not.toMatch(/gbrain-serve|gbrain-worker|gbrain-ops/);
  });

  test('take() produces all four named artifacts through those two primitives only', async () => {
    const runner = new FakeRunner();
    const manifest = await dockerVolumeDriver.take(
      { runId: 'run-1', volumes: snapshotVolumes(), databases: SNAPSHOT_DATABASES, outDir: dir, compose: COMPOSE },
      runner,
    );
    expect(manifest.artifacts.map((a) => a.name).sort()).toEqual(
      ['brain-db', 'brain-repos', 'control-db', 'gbrain-home'],
    );
    expect(manifest.driver).toBe('docker-volume');
    expect(manifest.runId).toBe('run-1');
    expect(runner.calls.filter((c) => c.includes('pg_dump'))).toHaveLength(2);
    // The tar calls, not the chown one-shot that follows each of them.
    const tarCalls = runner.calls.filter((c) => c[0] === 'docker' && c[1] === 'run' && c.includes('tar'));
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
      { runId: 'run-2', volumes: snapshotVolumes(), databases: SNAPSHOT_DATABASES, outDir: dir, compose: COMPOSE },
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
    const ctx = { runId: 'run-3', volumes: snapshotVolumes(), databases: SNAPSHOT_DATABASES, outDir: dir, compose: COMPOSE };
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

  test('volume restore removes a path absent from the archive', async () => {
    const volume = await mkdtemp(join(dir, 'vol-'));
    const archiveDir = await mkdtemp(join(dir, 'arc-'));
    const packed = await mkdtemp(join(dir, 'pack-'));
    await mkdir(join(volume, '.gbrain', 'persistence'), { recursive: true });
    await writeFile(join(volume, 'keep.txt'), 'kept');
    await writeFile(join(volume, '.gbrain', 'persistence', 'host.json'), '{}');
    await writeFile(join(packed, 'keep.txt'), 'kept');
    const packedTar = Bun.spawn(['tar', '-cf', join(archiveDir, 'snap.tar'), '-C', packed, 'keep.txt'], {
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(await packedTar.exited).toBe(0);

    await untarFileIntoVolume(new LocalRestoreRunner(volume, archiveDir), 'fixture-volume', archiveDir, 'snap.tar');

    expect(await Bun.file(join(volume, 'keep.txt')).text()).toBe('kept');
    expect(existsSync(join(volume, '.gbrain', 'persistence', 'host.json'))).toBe(false);
  });
});

/** Applies the restore argv to a local directory so the unit test sees a real deletion. */
class LocalRestoreRunner implements Runner {
  constructor(private volumeDir: string, private archiveDir: string) {}
  async run(argv: string[]): Promise<RunResult> {
    if (argv.includes('-tf')) {
      return hostTar(['-tf', this.hostArchive(argv)]);
    }
    if (argv.includes('find')) {
      const lines: string[] = [];
      const walk = async (current: string) => {
        for (const name of await readdir(current)) {
          const abs = join(current, name);
          lines.push(`/dst/${relative(this.volumeDir, abs)}`);
          if ((await stat(abs)).isDirectory()) await walk(abs);
        }
      };
      await walk(this.volumeDir);
      return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }
    if (argv.includes('rm')) {
      for (const arg of argv) {
        if (!arg.startsWith('/dst/')) continue;
        await rm(join(this.volumeDir, arg.slice('/dst/'.length)), { recursive: true, force: true });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (argv.includes('xf')) {
      return hostTar(['-xf', this.hostArchive(argv), '-C', this.volumeDir]);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  async captureToFile(): Promise<void> {
    throw new Error('not used');
  }
  async feedFile(): Promise<RunResult> {
    throw new Error('not used');
  }
  private hostArchive(argv: string[]): string {
    const member = argv.find((arg) => arg.startsWith('/in/'));
    if (!member) throw new Error('restore argv has no /in path');
    return join(this.archiveDir, member.slice('/in/'.length));
  }
}

async function hostTar(args: string[]): Promise<RunResult> {
  const p = Bun.spawn(['tar', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe('projectName / snapshotVolumes (D4)', () => {
  test('defaults to mobrain when COMPOSE_PROJECT_NAME is unset', () => {
    delete process.env.COMPOSE_PROJECT_NAME;
    expect(projectName()).toBe('mobrain');
    expect(snapshotVolumes()).toEqual(['mobrain_brain-repos', 'mobrain_gbrain-home']);
  });

  test('follows COMPOSE_PROJECT_NAME when the operator sets one', () => {
    process.env.COMPOSE_PROJECT_NAME = 'acme-brain';
    expect(snapshotVolumes()).toEqual(['acme-brain_brain-repos', 'acme-brain_gbrain-home']);
    delete process.env.COMPOSE_PROJECT_NAME;
  });

  test('the label a snapshot is filed under is project-independent', () => {
    process.env.COMPOSE_PROJECT_NAME = 'acme-brain';
    expect(volumeLabel('acme-brain_brain-repos')).toBe('brain-repos');
    delete process.env.COMPOSE_PROJECT_NAME;
  });
});
