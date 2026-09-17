import { test, expect, describe } from 'bun:test';
import type { RepoStatus } from '../../src/ops/git.ts';
import {
  PreflightRefusal, SNAPSHOT_SLACK, UsageError,
  parseArgs, preflight, type PreflightDeps, type UpgradeContext,
} from '../../scripts/upgrade.ts';

function fakeCtx(over: Partial<UpgradeContext> = {}): UpgradeContext {
  return {
    runId: 'run-test', fromVersion: '0.50.0.0', toVersion: '0.50.5.0', dryRun: false,
    upgradeDir: '/srv/upgrades/run-test', envPath: '.env',
    compose: ['docker', 'compose', '-f', 'compose/docker-compose.yml'],
    journal: null, now: () => new Date('2026-09-16T00:00:00.000Z'),
    ...over,
  } as UpgradeContext;
}

const cleanRepo = (sourceId: string): RepoStatus => ({
  sourceId, staleLock: false, lockAgeSeconds: null,
  uncommittedFiles: 0, unpushedCommits: 0, branch: 'main',
});

function fakeDeps(over: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    pendingDecisions: async () => [],
    resolvePlaybooks: () => [
      { version: '0.50.1.0', noPlaybookRequired: true, evidence: 'no upstream file' },
    ],
    inspectRepos: async () => [cleanRepo('handbook')],
    measureSnapshotBytes: async () => 10_000_000_000,
    freeBytes: async () => 100_000_000_000,
    captureDoctorBaseline: async () => ({
      gbrainVersion: '0.50.0.0', capturedAt: '2026-09-16T00:00:00.000Z',
      status: 'healthy', healthScore: 100, categoryScores: {}, checks: [],
    }),
    pushSources: async () => true,
    ...over,
  };
}

async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PreflightRefusal);
    return (error as PreflightRefusal).code;
  }
  throw new Error('expected preflight to refuse');
}

describe('parseArgs', () => {
  test('plan requires an explicit target', () => {
    expect(parseArgs(['plan', '--to', '0.50.5.0'])).toEqual({ cmd: 'plan', to: '0.50.5.0' });
    expect(() => parseArgs(['plan'])).toThrow(UsageError);
  });

  test('run carries the target and the confirmation flag', () => {
    expect(parseArgs(['run', '--to', '0.50.5.0', '--yes']))
      .toEqual({ cmd: 'run', to: '0.50.5.0', yes: true });
    expect(parseArgs(['run', '--to', '0.50.5.0']))
      .toEqual({ cmd: 'run', to: '0.50.5.0', yes: false });
  });

  test('a moving tag is refused by the CLI itself, not only by lint:forbidden', () => {
    for (const tag of ['latest', 'latest-stable', 'main', 'HEAD', 'v0.50.5.0']) {
      expect(() => parseArgs(['run', '--to', tag])).toThrow('not a four-part version');
    }
  });

  test('rollback addresses a run, never a version', () => {
    expect(parseArgs(['rollback', '--run', 'run-9'])).toEqual({ cmd: 'rollback', runId: 'run-9' });
    expect(() => parseArgs(['rollback'])).toThrow(UsageError);
    expect(() => parseArgs(['rollback', '--to', '0.50.0.0'])).toThrow(UsageError);
  });

  test('status takes an optional run id', () => {
    expect(parseArgs(['status'])).toEqual({ cmd: 'status', runId: null });
    expect(parseArgs(['status', '--run', 'run-9'])).toEqual({ cmd: 'status', runId: 'run-9' });
  });

  test('an unknown subcommand is a usage error, not a default', () => {
    expect(() => parseArgs(['upgrade', '--to', '0.50.5.0'])).toThrow(UsageError);
    expect(() => parseArgs([])).toThrow(UsageError);
  });
});

describe('preflight refusals', () => {
  test('a pending checklist item from a previous run refuses', async () => {
    const code = await refusalCode(() => preflight(fakeCtx(), fakeDeps({
      pendingDecisions: async () => [
        { id: 'i1', runId: 'run-old', version: '0.50.2.0', key: 'pre-0-50-0-0-cutover-attested',
          prompt: 'p', why: 'w', state: 'awaiting_admin_decision', decidedBy: null, decidedAt: null },
      ],
    })));
    expect(code).toBe('PENDING_CHECKLIST');
  });

  test('a version with no playbook refuses before anything is touched', async () => {
    let baselineCaptured = false;
    const code = await refusalCode(() => preflight(fakeCtx(), fakeDeps({
      resolvePlaybooks: () => { throw new Error('no playbook entry for 0.50.4.0'); },
      captureDoctorBaseline: async () => { baselineCaptured = true; throw new Error('unreachable'); },
    })));
    expect(code).toBe('NO_PLAYBOOK');
    expect(baselineCaptured).toBe(false);
  });

  test('uncommitted drift in a Space repo refuses', async () => {
    const code = await refusalCode(() => preflight(fakeCtx(), fakeDeps({
      inspectRepos: async () => [{ ...cleanRepo('handbook'), uncommittedFiles: 3 }],
    })));
    expect(code).toBe('REPO_DRIFT');
  });

  test('a stale git lock refuses: a crashed writer is not a quiesced one', async () => {
    const code = await refusalCode(() => preflight(fakeCtx(), fakeDeps({
      inspectRepos: async () => [{ ...cleanRepo('handbook'), staleLock: true, lockAgeSeconds: 900 }],
    })));
    expect(code).toBe('REPO_DRIFT');
  });

  test('insufficient disk for the snapshot refuses, with the slack applied', async () => {
    const code = await refusalCode(() => preflight(fakeCtx(), fakeDeps({
      measureSnapshotBytes: async () => 10_000_000_000,
      freeBytes: async () => Math.floor(10_000_000_000 * SNAPSHOT_SLACK) - 1,
    })));
    expect(code).toBe('INSUFFICIENT_DISK');
  });

  test('free space that cannot be measured refuses — a check that never ran is not a pass', async () => {
    const code = await refusalCode(() => preflight(fakeCtx(), fakeDeps({
      freeBytes: async () => { throw new Error('statfs unsupported'); },
    })));
    expect(code).toBe('DISK_UNMEASURABLE');
  });

  test('a baseline that cannot be captured refuses: there is nothing to gate against', async () => {
    const code = await refusalCode(() => preflight(fakeCtx(), fakeDeps({
      captureDoctorBaseline: async () => { throw new Error('doctor exited 127'); },
    })));
    expect(code).toBe('NO_BASELINE');
  });

  test('a target that is not ahead of the pin refuses', async () => {
    const code = await refusalCode(
      () => preflight(fakeCtx({ toVersion: '0.50.0.0' }), fakeDeps()),
    );
    expect(code).toBe('SAME_VERSION');
  });
});

describe('preflight success', () => {
  test('returns the plan, the measured numbers and the baseline', async () => {
    const report = await preflight(fakeCtx(), fakeDeps());
    expect(report.playbooks.map((p) => p.version)).toEqual(['0.50.1.0']);
    expect(report.requiredBytes).toBe(Math.ceil(10_000_000_000 * SNAPSHOT_SLACK));
    expect(report.freeBytes).toBe(100_000_000_000);
    expect(report.baseline.status).toBe('healthy');
    expect(report.sourcesPushed).toBe(true);
  });

  test('a failed sources push is reported, never fatal — it is best effort like backup.ts', async () => {
    const report = await preflight(fakeCtx(), fakeDeps({
      pushSources: async () => { throw new Error('remote unreachable'); },
    }));
    expect(report.sourcesPushed).toBe(false);
  });
});
