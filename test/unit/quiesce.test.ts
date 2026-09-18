import { test, expect, describe } from 'bun:test';
import { QUIESCE_ORDER, drainLane, restoreLane, verifySupervisorDrained } from '../../src/upgrade/quiesce.ts';
import type { ComposeModel, OpsCaller } from '../../src/upgrade/quiesce.ts';
import { SWAP_SERVICES } from '../../scripts/upgrade.ts';

function fakeOps(lines: string[], status: { running: boolean; workers: unknown[] } | null): OpsCaller {
  return {
    kind: 'stub',
    async auditTail(): Promise<string[]> { return lines; },
    async supervisorStatus() { return status; },
  };
}

describe('verifySupervisorDrained', () => {
  test('a clean SIGTERM exit with an empty worker list is a real drain', async () => {
    const ops = fakeOps(
      [JSON.stringify({ event: 'stopped', exit_code: 0, reason: 'SIGTERM' })],
      { running: false, workers: [] },
    );
    const proof = await verifySupervisorDrained({ ops });
    expect(proof.clean).toBe(true);
    expect(proof.exitCode).toBe(0);
    expect(proof.classification).toBe('clean');
  });

  // U9 / honesty rule 3: the assertion that matters. The PID vanishing inside
  // the poll window is NOT proof of a clean exit on its own.
  test('a MAX_CRASHES exit in the same window is never reported as clean', async () => {
    const ops = fakeOps(
      [JSON.stringify({ event: 'stopped', exit_code: 1, reason: 'MAX_CRASHES' })],
      { running: false, workers: [] },
    );
    const proof = await verifySupervisorDrained({ ops });
    expect(proof.clean).toBe(false);
    expect(proof.classification).toBe('crashed');
  });

  test('exit code 4 (LOCK_LOST) is its own classification, not folded into "crashed"', async () => {
    const ops = fakeOps(
      [JSON.stringify({ event: 'stopped', exit_code: 4, reason: 'SIGTERM' })],
      { running: false, workers: [] },
    );
    const proof = await verifySupervisorDrained({ ops });
    expect(proof.clean).toBe(false);
    expect(proof.classification).toBe('lock_lost');
  });

  test('no stopped event at all is "unproven", not silently clean', async () => {
    const ops = fakeOps([], { running: false, workers: [] });
    const proof = await verifySupervisorDrained({ ops });
    expect(proof.clean).toBe(false);
    expect(proof.classification).toBe('unproven');
    expect(proof.exitCode).toBeNull();
  });

  test('a clean audit event contradicted by a still-running status is not clean', async () => {
    const ops = fakeOps(
      [JSON.stringify({ event: 'stopped', exit_code: 0, reason: 'SIGTERM' })],
      { running: true, workers: [{ pid: 999 }] },
    );
    const proof = await verifySupervisorDrained({ ops });
    expect(proof.clean).toBe(false);
  });

  test('only the LAST stopped event counts, not an earlier one from a prior cycle', async () => {
    const ops = fakeOps(
      [
        JSON.stringify({ event: 'stopped', exit_code: 1, reason: 'MAX_CRASHES' }),
        JSON.stringify({ event: 'started' }),
        JSON.stringify({ event: 'stopped', exit_code: 0, reason: 'SIGTERM' }),
      ],
      { running: false, workers: [] },
    );
    const proof = await verifySupervisorDrained({ ops });
    expect(proof.clean).toBe(true);
  });
});

// F1: at 0.50.0.0 a CLEAN stop emits `shutting_down {reason:'SIGTERM',
// exit_code:0}` and no `stopped`; a LOCK_LOST stop emits health_error +
// shutting_down + stopped all carrying `supervisor_lock_lost`/4. The
// classifier is window-scoped so a stale episode cannot decide a later drain.
// These fixtures reproduce the exact raw rows captured from the live stack.
describe('verifySupervisorDrained: windowed classifier', () => {
  // taken verbatim from the controlled runs' audit JSONL
  const STALE_LOCK_LOST_STOPPED = {
    event: 'stopped', ts: '2026-09-16T23:45:22.882Z',
    reason: 'supervisor_lock_lost', exit_code: 4, supervisor_pid: 8,
  };
  const CLEAN_SHUTTING_DOWN = {
    event: 'shutting_down', ts: '2026-09-17T00:28:20.611Z',
    reason: 'SIGTERM', exit_code: 0, supervisor_pid: 7,
  };
  const IN_WINDOW_LOCK_LOST = [
    {
      event: 'health_error', ts: '2026-09-17T00:29:43.390Z', reason: 'supervisor_lock_lost',
      detail: 'fenced refresh matched 0 rows (stolen or force-cleared)', supervisor_pid: 7,
    },
    {
      event: 'shutting_down', ts: '2026-09-17T00:29:43.390Z',
      reason: 'supervisor_lock_lost', exit_code: 4, supervisor_pid: 7,
    },
    {
      event: 'stopped', ts: '2026-09-17T00:29:43.403Z',
      reason: 'supervisor_lock_lost', exit_code: 4, supervisor_pid: 7,
    },
  ];

  test('an in-window shutting_down with exit_code 0 classifies clean (and exposes the window)', async () => {
    const since = '2026-09-17T00:28:00.000Z';
    const ops = fakeOps([JSON.stringify(CLEAN_SHUTTING_DOWN)], { running: false, workers: [] });
    const proof = await verifySupervisorDrained({ ops, since });
    expect(proof.classification).toBe('clean');
    expect(proof.clean).toBe(true);
    expect(proof.exitCode).toBe(0);
    expect(proof.reason).toBe('SIGTERM');
    expect(proof.decidingEvent?.event).toBe('shutting_down');
    expect(proof.windowStart).toBe(new Date(Date.parse(since)).toISOString());
    expect(typeof proof.windowEnd).toBe('string');
  });

  test('an OUT-OF-WINDOW lock-lost stopped does not misclassify a clean in-window drain', async () => {
    const since = '2026-09-17T00:28:00.000Z';
    const ops = fakeOps(
      [
        JSON.stringify(STALE_LOCK_LOST_STOPPED),                 // 35 min stale
        JSON.stringify({ event: 'started', ts: '2026-09-17T00:24:51.057Z' }),
        JSON.stringify(CLEAN_SHUTTING_DOWN),                      // in window
      ],
      { running: false, workers: [] },
    );
    const proof = await verifySupervisorDrained({ ops, since });
    expect(proof.classification).toBe('clean');
    expect(proof.clean).toBe(true);
    expect(proof.exitCode).toBe(0);
    expect(proof.decidingEvent?.event).toBe('shutting_down');
  });

  test('an in-window lock-lost stopped classifies lock_lost, not crashed or clean', async () => {
    const since = '2026-09-17T00:29:00.000Z';
    const ops = fakeOps(IN_WINDOW_LOCK_LOST.map((e) => JSON.stringify(e)), { running: false, workers: [] });
    const proof = await verifySupervisorDrained({ ops, since });
    expect(proof.classification).toBe('lock_lost');
    expect(proof.clean).toBe(false);
    expect(proof.exitCode).toBe(4);
    expect(proof.reason).toBe('supervisor_lock_lost');
    expect(proof.decidingEvent?.event).toBe('stopped');
  });

  test('an in-window non-zero exit with a non-lock reason classifies crashed', async () => {
    const since = '2026-09-17T00:29:00.000Z';
    const ops = fakeOps(
      [JSON.stringify({ event: 'stopped', ts: '2026-09-17T00:29:10.000Z', reason: 'MAX_CRASHES', exit_code: 1 })],
      { running: false, workers: [] },
    );
    const proof = await verifySupervisorDrained({ ops, since });
    expect(proof.classification).toBe('crashed');
    expect(proof.clean).toBe(false);
    expect(proof.exitCode).toBe(1);
  });

  test('a window with no deciding event classifies unproven, never clean', async () => {
    const since = '2026-09-17T00:29:00.000Z';
    const ops = fakeOps(
      [
        JSON.stringify(STALE_LOCK_LOST_STOPPED),
        JSON.stringify({ event: 'started', ts: '2026-09-17T00:24:51.057Z' }),
      ],
      { running: false, workers: [] },
    );
    const proof = await verifySupervisorDrained({ ops, since });
    expect(proof.classification).toBe('unproven');
    expect(proof.clean).toBe(false);
    expect(proof.exitCode).toBeNull();
    expect(proof.decidingEvent).toBeNull();
  });
});

// D13 / Task 14. The lane's ordering is a decision, not an accident: the runner
// is the one consumer that keeps writing to the brain after the scheduler stops
// materializing, so it drains FIRST.
describe('the quiesce lane (D13)', () => {
  test('the runner drains first, before the scheduler', () => {
    expect(QUIESCE_ORDER[0]).toBe('agent-runner');
    expect(QUIESCE_ORDER.indexOf('agent-runner'))
      .toBeLessThan(QUIESCE_ORDER.indexOf('scheduler'));
  });

  test('a gbrain pin move does not rebuild the runner — its image carries no gbrain', () => {
    expect(SWAP_SERVICES as readonly string[]).not.toContain('agent-runner');
  });

  // D12: the runner is behind the `runner` profile, OFF by default. The lane
  // may only ever name a service this compose project actually has.
  test('a service outside the active compose model is never in the lane', () => {
    const writers = new Set(['scheduler', 'gbrain-worker', 'control-plane', 'gbrain-serve', 'gbrain-ops']);
    const runnerOff: ComposeModel = { active: writers, containers: new Set() };
    const runnerOn: ComposeModel = {
      active: new Set(['agent-runner', ...writers]), containers: new Set(),
    };

    expect(drainLane(runnerOff)).toEqual([...QUIESCE_ORDER].filter((s) => s !== 'agent-runner'));
    expect(restoreLane(runnerOff)).toEqual([...QUIESCE_ORDER].filter((s) => s !== 'agent-runner').reverse());
    // Profile enabled: the runner is drained first and restored last.
    expect(drainLane(runnerOn)).toEqual([...QUIESCE_ORDER]);
    expect(restoreLane(runnerOn)).toEqual([...QUIESCE_ORDER].reverse());

    // A runner container can exist while its profile is off (`up -d --no-deps`
    // starts a profile-gated service either way). It is still a live writer, so
    // it is drained — and never restarted, because the operator's own model
    // says the runner is not part of this deployment.
    const stray: ComposeModel = { active: writers, containers: new Set(['agent-runner']) };
    expect(drainLane(stray)[0]).toBe('agent-runner');
    expect(restoreLane(stray)).toEqual([...QUIESCE_ORDER].filter((s) => s !== 'agent-runner').reverse());

    // A project compose cannot render is not evidence that a writer is absent:
    // the pre-Task-14 behaviour stands for the DRAIN (stop everything in the
    // order) rather than silently skipping a drain. The RESTORE direction is
    // the one that starts containers, so it is the one that must not trust the
    // missing model: `up -d --no-deps agent-runner` starts a profile-gated
    // service regardless of the profile (measured), so an unknown model
    // restores every requested service EXCEPT the runner. An assertion that
    // still accepts agent-runner here is pinning a path to the runner.
    expect(drainLane('unknown')).toEqual([...QUIESCE_ORDER]);
    expect(restoreLane('unknown')).toEqual(
      [...QUIESCE_ORDER].filter((s) => s !== 'agent-runner').reverse(),
    );
    expect(restoreLane('unknown')).not.toContain('agent-runner');
    // An explicit resume() request cannot name what the project does not have.
    expect(restoreLane({ active: new Set(['scheduler']), containers: new Set() },
      ['scheduler', 'control-plane'])).toEqual(['scheduler']);
  });
});
