import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256File, buildManifest, verifyManifest } from '../../src/upgrade/manifest.ts';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});
async function scratch(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'upgrade-manifest-'));
  return dir;
}

describe('sha256File / buildManifest', () => {
  test('sha256File hashes real file content', async () => {
    const d = await scratch();
    const path = join(d, 'a.txt');
    await writeFile(path, 'hello');
    expect(await sha256File(path)).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  test('buildManifest records name, path, bytes and sha256 for each artifact', async () => {
    const d = await scratch();
    const brainPath = join(d, 'brain.sql');
    const reposPath = join(d, 'brain-repos.tar');
    await writeFile(brainPath, 'brain dump');
    await writeFile(reposPath, 'tar bytes');

    const manifest = await buildManifest({
      id: 'snap-1', runId: 'run-1', fromVersion: '0.50.0.0', driver: 'docker-volume',
      artifacts: [{ name: 'brainDb', path: brainPath }, { name: 'brainRepos', path: reposPath }],
      quiesce: { stoppedServices: ['scheduler', 'gbrain-worker'], drainProofs: {} },
    });

    expect(manifest.id).toBe('snap-1');
    expect(manifest.runId).toBe('run-1');
    expect(manifest.artifacts).toHaveLength(2);
    const brain = manifest.artifacts.find((a) => a.name === 'brainDb')!;
    expect(brain.path).toBe('brain.sql'); // stored relative — the manifest is portable
    expect(brain.bytes).toBe('brain dump'.length);
    expect(brain.sha256).toBe(await sha256File(brainPath));
  });

  test('buildManifest refuses when an artifact file is missing', async () => {
    const d = await scratch();
    await expect(buildManifest({
      id: 'snap-2', runId: 'run-1', fromVersion: '0.50.0.0', driver: 'docker-volume',
      artifacts: [{ name: 'controlDb', path: join(d, 'nope.sql') }],
      quiesce: { stoppedServices: [], drainProofs: {} },
    })).rejects.toThrow('artifact "controlDb" is missing');
  });
});

describe('verifyManifest', () => {
  test('reports ok for an untouched snapshot directory', async () => {
    const d = await scratch();
    await writeFile(join(d, 'a.sql'), 'dump');
    const manifest = await buildManifest({
      id: 'snap-3', runId: 'run-1', fromVersion: '0.50.0.0', driver: 'docker-volume',
      artifacts: [{ name: 'controlDb', path: join(d, 'a.sql') }],
      quiesce: { stoppedServices: [], drainProofs: {} },
    });
    expect(await verifyManifest(manifest, d)).toEqual({ ok: true, mismatches: [] });
  });

  // Honesty rule 10: a snapshot nobody checksums is not a backup. Same byte
  // length as the original — a size-only check would miss this.
  test('catches a tampered artifact by sha256, not by size or presence alone', async () => {
    const d = await scratch();
    const path = join(d, 'a.sql');
    await writeFile(path, 'original dump');
    const manifest = await buildManifest({
      id: 'snap-4', runId: 'run-1', fromVersion: '0.50.0.0', driver: 'docker-volume',
      artifacts: [{ name: 'controlDb', path }],
      quiesce: { stoppedServices: [], drainProofs: {} },
    });
    await writeFile(path, 'originai dump');
    const result = await verifyManifest(manifest, d);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual(['controlDb: sha256 mismatch']);
  });

  test('reports a missing artifact distinctly from a mismatch', async () => {
    const d = await scratch();
    const path = join(d, 'a.sql');
    await writeFile(path, 'dump');
    const manifest = await buildManifest({
      id: 'snap-5', runId: 'run-1', fromVersion: '0.50.0.0', driver: 'docker-volume',
      artifacts: [{ name: 'controlDb', path }],
      quiesce: { stoppedServices: [], drainProofs: {} },
    });
    await rm(path);
    const result = await verifyManifest(manifest, d);
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]).toContain('controlDb: missing at');
  });
});
