import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RollbackRefusal, rollback } from '../../src/upgrade/digest.ts';
import type { UpgradeContext } from '../../scripts/upgrade.ts';

let dir: string;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const ARTIFACTS = [
  { name: 'brainDb', file: 'brain.sql', body: '-- brain dump\n' },
  { name: 'controlDb', file: 'control.sql', body: '-- control dump\n' },
  { name: 'brainRepos', file: 'brain-repos.tar', body: 'repos-tar-bytes' },
  { name: 'gbrainHome', file: 'gbrain-home.tar', body: 'home-tar-bytes' },
];

async function seedRun(tamper: string | null): Promise<{ ctx: UpgradeContext; calls: string[] }> {
  const runDir = join(dir, 'run-1');
  await Bun.write(join(runDir, '.keep'), '');
  for (const a of ARTIFACTS) {
    const body = tamper === a.name ? `${a.body}X` : a.body;
    await writeFile(join(runDir, a.file), body);
  }
  const manifest = {
    id: 'snap-1', runId: 'run-1', takenAt: '2026-09-16T00:00:00.000Z',
    fromVersion: '0.50.0.0', driver: 'docker-volume',
    artifacts: ARTIFACTS.map((a) => ({
      name: a.name, path: a.file, bytes: a.body.length, sha256: sha(a.body),
    })),
    quiesce: { stopped: [], proof: 'test' },
  };
  await writeFile(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(runDir, 'journal.ndjson'),
    `${JSON.stringify({ runId: 'run-1', seq: 1, at: manifest.takenAt, state: 'swapped' })}\n`);

  const calls: string[] = [];
  const ctx = {
    runId: 'run-1', fromVersion: '0.50.5.0', toVersion: '0.50.5.0', dryRun: false,
    upgradeDir: runDir, envPath: join(runDir, '.env'),
    compose: ['docker', 'compose'], journal: null, now: () => new Date(),
  } as unknown as UpgradeContext;
  await writeFile(ctx.envPath, 'GBRAIN_VERSION=0.50.5.0\n');
  return { ctx, calls };
}

function fakeDeps(calls: string[]) {
  return {
    driver: {
      id: 'fake',
      async restore() { calls.push('restore'); },
      async take() { throw new Error('not used'); },
      async verify() { calls.push('driver-verify'); return { ok: true, mismatches: [] }; },
      describe() { return []; },
    },
    async quiesce() { calls.push('quiesce'); return { stopped: [], proof: 'test', elapsedMs: 1 }; },
    async resume() { calls.push('resume'); },
    async buildImages() { calls.push('build'); },
    async recreate() { calls.push('recreate'); },
    async verifyRuntimePin() { calls.push('verify-pin'); return true; },
    async stateDigest() {
      calls.push('digest');
      return {
        takenAt: 'x', gbrainVersion: '0.50.0.0', configKeys: [],
        pages: 0, sources: [], controlRowCounts: {},
        filePlane: { name: 'filePlane', sha256: '0'.repeat(64), items: 0, scope: 'test' },
        parts: [],
      };
    },
  };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'brainstand-rollback-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('rollback', () => {
  test('a tampered artifact aborts the rollback before anything is restored', async () => {
    const { ctx, calls } = await seedRun('brainRepos');
    let refusal: RollbackRefusal | null = null;
    try {
      await rollback(ctx, 'run-1', fakeDeps(calls));
    } catch (e) {
      refusal = e as RollbackRefusal;
    }
    expect(refusal).toBeInstanceOf(RollbackRefusal);
    expect(refusal!.code).toBe('MANIFEST_VERIFY_FAILED');
    expect(refusal!.message).toContain('brainRepos');
    // The point of the test: a bad manifest must not restore garbage over a
    // stack that is merely half-upgraded.
    expect(calls).not.toContain('restore');
    expect(calls).not.toContain('quiesce');
  });

  test('an intact manifest restores, puts the pin back and verifies, in that order', async () => {
    const { ctx, calls } = await seedRun(null);
    const report = await rollback(ctx, 'run-1', fakeDeps(calls));
    expect(report.ok).toBe(true);
    expect(report.pin).toBe('0.50.0.0');
    expect(await Bun.file(ctx.envPath).text()).toContain('GBRAIN_VERSION=0.50.0.0');
    expect(calls).toEqual(['quiesce', 'restore', 'build', 'recreate', 'resume', 'verify-pin', 'digest']);
  });

  test('a missing artifact file is a verification failure, not a crash', async () => {
    const { ctx, calls } = await seedRun(null);
    await rm(join(dir, 'run-1', 'gbrain-home.tar'));
    await expect(rollback(ctx, 'run-1', fakeDeps(calls))).rejects.toThrow('MANIFEST_VERIFY_FAILED');
    expect(calls).not.toContain('restore');
  });

  test('a missing manifest refuses with the run id, not an ENOENT stack', async () => {
    const { ctx, calls } = await seedRun(null);
    await rm(join(dir, 'run-1', 'manifest.json'));
    await expect(rollback(ctx, 'run-1', fakeDeps(calls)))
      .rejects.toThrow('no snapshot manifest for run run-1');
  });

  // BUG 1 (Task 17): `rollback()` used to `await import('../../scripts/upgrade.ts')`
  // to borrow `writePin`. Because `scripts/upgrade.ts` imports `digest.ts`, that
  // dynamic import re-enters the CLI entry module and Bun spins a core forever —
  // observed as the real rollback hanging after `restore` with no child
  // processes. `writePin` now lives in `src/contracts/pin.ts`, imported
  // statically, so no `src/upgrade` module may reach back into `scripts/`.
  test('no src/upgrade module imports the host CLI back (the rollback spin)', async () => {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir('src/upgrade')).filter((f) => f.endsWith('.ts'));
    const offenders: string[] = [];
    for (const f of files) {
      const text = await Bun.file(`src/upgrade/${f}`).text();
      if (/import\(\s*['"][^'"]*scripts\/upgrade/.test(text)) offenders.push(`src/upgrade/${f}`);
    }
    expect(offenders).toEqual([]);
  });
});
