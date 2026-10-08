import { test, expect, describe } from 'bun:test';
import type { RepoStatus } from '../../src/ops/git.ts';
import {
  PreflightRefusal, SNAPSHOT_SLACK, UsageError,
  composeArgv, parseArgs, preflight, type PreflightDeps, type UpgradeContext,
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
    inFlightRuns: async () => [],
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

describe('composeArgv', () => {
  const exists = (path: string) => path === '.env' || path === 'compose/docker-compose.dev.yml';

  test('the default is the base file only', () => {
    expect(composeArgv({}, exists)).toEqual([
      'docker', 'compose', '--env-file', '.env', '-f', 'compose/docker-compose.yml',
    ]);
  });

  test('MOBRAIN_COMPOSE_FILES appends host overrides and refuses a missing file', () => {
    expect(composeArgv({ MOBRAIN_COMPOSE_FILES: 'compose/docker-compose.dev.yml' }, exists)).toEqual([
      'docker', 'compose', '--env-file', '.env', '-f', 'compose/docker-compose.yml',
      '-f', 'compose/docker-compose.dev.yml',
    ]);
    expect(() => composeArgv({ MOBRAIN_COMPOSE_FILES: 'compose/missing.yml' }, exists))
      .toThrow('missing file');
  });
});

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

  // D13 / Task 14. This check is the one quiesce.ts's own stop-grace doc block
  // claimed Task 11 preflight already made, and did not: preflight had no
  // in-flight-run dependency at all. It matters most for the agent lane, where
  // one run is a 20-minute harness writing pages — and a snapshot taken
  // mid-write freezes a half-written brain, which is the inconsistency the
  // quiesce drain proof exists to prevent in the first place.
  test('a run held right now refuses, before the repos are inspected', async () => {
    let reposInspected = false;
    const code = await refusalCode(() => preflight(fakeCtx(), fakeDeps({
      inFlightRuns: async () => [
        { id: 'run-held', scheduleId: 'sch-1', jobType: 'agent_prompt', state: 'running',
          startedAt: '2026-09-17T03:00:00.000Z', claimedBy: 'runner-1' },
      ],
      // A live run is writing to a Space AS preflight runs, so inspecting the
      // repos first would report the run's own uncommitted files as REPO_DRIFT
      // and refuse the upgrade for the wrong reason with the wrong code.
      inspectRepos: async () => {
        reposInspected = true;
        return [{ ...cleanRepo('handbook'), uncommittedFiles: 1 }];
      },
    })));
    expect(code).toBe('RUN_IN_FLIGHT');
    expect(reposInspected).toBe(false);
  });

  test('a run ledger that cannot be read refuses, and never passes vacuously', async () => {
    const code = await refusalCode(() => preflight(fakeCtx(), fakeDeps({
      inFlightRuns: async () => { throw new Error('psql exited 1'); },
    })));
    expect(code).toBe('RUN_IN_FLIGHT');
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

  // The other half of D13's refusal: it fires on a HELD claim and on nothing
  // else. An idle ledger is the normal state between runs — `pending` rows are
  // materialized future occurrences that every enabled schedule has all day, so
  // a refusal keyed on "any row exists" would refuse every upgrade forever.
  test('an idle run ledger is not a refusal', async () => {
    let asked = 0;
    const report = await preflight(fakeCtx(), fakeDeps({
      inFlightRuns: async () => { asked += 1; return []; },
    }));
    expect(asked).toBe(1);
    expect(report.fromVersion).toBe('0.50.0.0');
    expect(report.baseline.status).toBe('healthy');
  });
});
