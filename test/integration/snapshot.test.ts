import { test, expect, describe } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tarVolumeToFile, untarFileIntoVolume } from '../../src/upgrade/snapshot.ts';
import type { Runner, RunResult } from '../../src/upgrade/snapshot.ts';

const dockerAvailable = Bun.which('docker') !== null;
const SKIP_SNAPSHOT_DOCKER_CHECK_ENV = 'BRAINSTAND_ALLOW_SKIP_SNAPSHOT_DOCKER_CHECK';

async function run(argv: string[]): Promise<RunResult> {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { exitCode, stdout, stderr };
}
const realRunner: Runner = {
  run: (argv) => run(argv),
  captureToFile: async () => { throw new Error('not exercised by this test'); },
  feedFile: async () => { throw new Error('not exercised by this test'); },
};

describe('docker-volume driver: real round trip', () => {
  test.skipIf(!dockerAvailable)(
    'a tar out of a scratch volume, followed by an untar into a fresh one, round-trips the content',
    async () => {
      const volume = `bs-snap-scratch-${randomUUID().slice(0, 8)}`;
      const restoreVolume = `${volume}-restore`;
      const hostDir = await mkdtemp(join(tmpdir(), 'bs-snap-it-'));
      try {
        expect((await run(['docker', 'volume', 'create', volume])).exitCode).toBe(0);
        expect((await run(['docker', 'volume', 'create', restoreVolume])).exitCode).toBe(0);

        const seed = await run([
          'docker', 'run', '--rm', '-v', `${volume}:/src`, 'busybox',
          'sh', '-c', 'echo "snapshot-round-trip" > /src/marker.txt',
        ]);
        expect(seed.exitCode).toBe(0);

        await tarVolumeToFile(realRunner, volume, hostDir, 'scratch.tar');
        await untarFileIntoVolume(realRunner, restoreVolume, hostDir, 'scratch.tar');

        const read = await run([
          'docker', 'run', '--rm', '-v', `${restoreVolume}:/dst:ro`, 'busybox', 'cat', '/dst/marker.txt',
        ]);
        expect(read.exitCode).toBe(0);
        expect(read.stdout.trim()).toBe('snapshot-round-trip');
      } finally {
        await run(['docker', 'volume', 'rm', '-f', volume]);
        await run(['docker', 'volume', 'rm', '-f', restoreVolume]);
        await rm(hostDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  // Same convention as test/integration/compose-invariants.test.ts: a skipped
  // Docker check must be loud, not silent.
  test('the Docker-dependent round trip above is not silently skipped', () => {
    if (dockerAvailable) return;
    if (process.env[SKIP_SNAPSHOT_DOCKER_CHECK_ENV] === '1') return;
    throw new Error(
      'Docker is unavailable, so the scratch-volume snapshot round trip was skipped. If that is ' +
      `genuinely intended for this run, set ${SKIP_SNAPSHOT_DOCKER_CHECK_ENV}=1 to acknowledge it.`,
    );
  });
});
