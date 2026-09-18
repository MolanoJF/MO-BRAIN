import { test, expect, describe } from 'bun:test';
import { existsSync } from 'node:fs';
import { QUIESCE_ORDER, composeModel, drainLane, quiesce, resume, restoreLane } from '../../src/upgrade/quiesce.ts';
import type { ComposeModel } from '../../src/upgrade/quiesce.ts';
import type { UpgradeContext } from '../../src/upgrade/types.ts';
import { withStackExclusion } from '../helpers/stack.ts';

const COMPOSE = [
  'docker', 'compose',
  ...(existsSync('.env') ? ['--env-file', '.env'] as const : []),
  '-f', 'compose/docker-compose.yml',
];
const SKIP_QUIESCE_INTEGRATION_ENV = 'BRAINSTAND_ALLOW_SKIP_QUIESCE_INTEGRATION';

/** Same shape as test/integration/backup.test.ts's probeBackupStack —
 *  quiesce needs the real stack up, not merely the Docker CLI present. */
async function probeStack(): Promise<boolean> {
  const p = Bun.spawn(
    [...COMPOSE, 'ps', '--status', 'running', '-q', 'postgres', 'gbrain-ops', 'scheduler'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const timer = setTimeout(() => p.kill(), 5_000);
  try {
    const [stdout, exitCode] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (exitCode !== 0) return false;
    return stdout.trim().split(/\s+/).filter(Boolean).length >= 3;
  } catch { return false; } finally { clearTimeout(timer); }
}
const stackAvailable = await probeStack();

async function runningServices(): Promise<string[]> {
  const p = Bun.spawn([...COMPOSE, 'ps', '--services', '--filter', 'status=running'],
    { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(p.stdout).text();
  await p.exited;
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

describe('quiesce: real stack', () => {
  test('quiesce integration tests are not silently skipped', () => {
    if (stackAvailable) return;
    if (process.env[SKIP_QUIESCE_INTEGRATION_ENV] === '1') return;
    throw new Error(
      'The full compose stack is not up, so the real quiesce/resume round trip was skipped. Bring ' +
      'it up with docker compose --env-file .env -f compose/docker-compose.yml up -d --wait, or set ' +
      `${SKIP_QUIESCE_INTEGRATION_ENV}=1 to acknowledge skipping it for this run.`,
    );
  });

  test.skipIf(!stackAvailable)(
    'stops every service but postgres, in QUIESCE_ORDER, and resume brings them all back',
    async () => {
      const ctx = {
        runId: 'quiesce-it', fromVersion: process.env.GBRAIN_VERSION ?? '0.50.0.0',
        toVersion: process.env.GBRAIN_VERSION ?? '0.50.0.0', dryRun: false,
        upgradeDir: '/tmp/quiesce-it', envPath: '.env', compose: COMPOSE,
        journal: null, now: () => new Date(),
      } as unknown as UpgradeContext;

      // The lane THIS host's project declares, read before anything is
      // stopped: quiesce() and resume() both walk it (D12/D13), so the two
      // assertions below are about the same list the production code uses.
      const model = await composeModel(COMPOSE);
      if (model === 'unknown') throw new Error('the live compose project could not be rendered');

      // The whole round trip holds the stack exclusively. backup.test.ts runs
      // the real scripts/backup.ts (which stops these same services and writes
      // its manifest from a `jobs.supervisorStatus` read); with files running
      // concurrently, this file's stop/resume can invalidate that read and
      // backup's own stop/start can invalidate the `backUp` assertion below.
      // See withStackExclusion for why the lock is per-leg and not `--parallel=1`.
      await withStackExclusion('quiesce.test.ts', async () => {
        try {
          const evidence = await quiesce(ctx);
          expect(evidence.stopped).toEqual([...QUIESCE_ORDER]);

          // Plan defect corrected (evidence: `docker compose ps` shows `caddy`
          // Up, and caddy is not in QUIESCE_ORDER). The plan's literal
          // `toEqual(['postgres'])` omits the stateless ingress QUIESCE_ORDER
          // deliberately never stops (D3 stops writers only), so it cannot hold
          // on a stock stack. Assert the load-bearing claim directly instead:
          // every writer is down, postgres is up, and nothing beyond postgres +
          // caddy is left running. This is not weaker than `['postgres']` — it
          // still fails if any QUIESCE_ORDER service survives or an unexpected
          // service appears.
          const afterQuiesce = await runningServices();
          expect(afterQuiesce).toContain('postgres');
          for (const svc of QUIESCE_ORDER) expect(afterQuiesce).not.toContain(svc);
          expect(afterQuiesce.filter((s) => s !== 'postgres' && s !== 'caddy')).toEqual([]);
        } finally {
          // The task requires the live stack be left healthy even when an
          // assertion (or a mid-quiesce stop) fails, so restore unconditionally.
          // The plan sample only resumed on the success path.
          await resume(ctx);
        }

        // Task 14, D12/D13. This used to read
        //   `for (const svc of QUIESCE_ORDER) expect(backUp).toContain(svc);`
        // and that is exactly the assertion the runner lane breaks BY DESIGN: on a
        // stack that never enabled the `runner` profile, resume() must not bring
        // the runner back — `up -d --no-deps` CREATES a profile-gated service
        // whether or not its profile is active (measured), which would switch an
        // agent runner on during an upgrade nobody asked to have it. Not a
        // weakening: the quiesce half above still proves every writer in
        // QUIESCE_ORDER is down, this half requires EVERY service the project
        // declares to be back (including `agent-runner` whenever the operator has
        // it enabled), and it adds a requirement the old line could not express at
        // all — a service whose profile is inactive is deliberately NOT started.
        const restored = restoreLane(model);
        const backUp = await runningServices();
        expect(restored.length).toBeGreaterThan(0);
        for (const svc of restored) expect(backUp).toContain(svc);
        for (const svc of QUIESCE_ORDER) {
          if (model.active.has(svc)) continue;
          expect(backUp).not.toContain(svc);
        }
      });
    },
    600_000,
  );

  // The positive half of D13, at the seam quiesce() and resume() both read. It
  // is a model assertion rather than a live round trip because this compose file
  // does not have the runner yet: `docker compose stop agent-runner` on a
  // project without that service exits 1 ("no such service"), which is why the
  // lane is model-derived in the first place.
  test('with the runner profile active, the runner is drained first and restored last', () => {
    const writers = ['scheduler', 'gbrain-worker', 'control-plane', 'gbrain-serve', 'gbrain-ops'];
    const noContainers: ReadonlySet<string> = new Set();
    const runnerOn: ComposeModel = {
      active: new Set(['agent-runner', ...writers]), containers: noContainers,
    };
    expect(drainLane(runnerOn)).toEqual([...QUIESCE_ORDER]);
    expect(drainLane(runnerOn)[0]).toBe('agent-runner');
    expect(restoreLane(runnerOn)).toEqual([...QUIESCE_ORDER].reverse());
    expect(restoreLane(runnerOn).at(-1)).toBe('agent-runner');

    // ... and with the runner dormant, the same model is what the live test
    // above asserts against.
    const runnerOff: ComposeModel = { active: new Set(writers), containers: noContainers };
    expect(drainLane(runnerOff)).toEqual([...QUIESCE_ORDER].filter((svc) => svc !== 'agent-runner'));
    expect(restoreLane(runnerOff)).not.toContain('agent-runner');

    // An unreadable project is no better: the drain still stops everything
    // (stopping a profile-off runner exits 0), but the restore must not start
    // it — `up -d --no-deps agent-runner` ignores the profile (measured), so
    // an unknown model restoring agent-runner is a path to the runner.
    expect(drainLane('unknown')).toEqual([...QUIESCE_ORDER]);
    expect(restoreLane('unknown')).not.toContain('agent-runner');
    expect(restoreLane('unknown')).toEqual(
      [...QUIESCE_ORDER].filter((svc) => svc !== 'agent-runner').reverse(),
    );
  });
});
