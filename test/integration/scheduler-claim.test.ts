import { test, expect, describe, beforeAll, beforeEach, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, pinDb, runMigrations, schema } from '../../src/control/db/client.ts';
import {
  QUEUE_DEPTH_CAP, claimNextRun, finishRun, heartbeat, reclaimExpiredLeases, type ClaimedRun,
} from '../../src/scheduler/claim.ts';

const ORG = `org-${randomUUID()}`;

/**
 * The clock is injected (see Task 8), and this suite pins ONE instant for the
 * whole file. Unlike `materializeDue`, which is scoped per schedule,
 * `claimNextRun` and `reclaimExpiredLeases` scan `schedule_runs` globally —
 * there is no org filter to scope them with. A `now` in real time would
 * therefore let another suite's concurrently-inserted fixtures (the DST
 * fixtures sit at 2026-03-08 / 2026-09-15 / 2026-11-01) win the "oldest due
 * pending run" race, so every probe here stays strictly before them.
 */
const now = Date.UTC(2025, 5, 1, 12, 0); // 2025-06-01T12:00Z

/** D2: the scheduler's own consumer set — the command lane, and only it. */
const SCHEDULER = { jobTypes: ['gbrain_command'] } as const;
/** D2: `/api/runs/claim`'s consumer set — the agent lane, and only it. */
const RUNNER = { jobTypes: ['agent_prompt'] } as const;

beforeAll(async () => {
  pinDb();
  await runMigrations();
  await getDb().insert(schema.organizations).values({
    id: ORG, name: 'Claim', slug: `claim-${randomUUID().slice(0, 8)}`, timezone: 'UTC',
  });
});

afterAll(async () => {
  await getDb().delete(schema.organizations).where(eq(schema.organizations.id, ORG));
  await closeDb();
});

// Cascades each test's runs away; alerts survive the cascade by design, so
// they are cleared explicitly rather than left to accumulate in a shared DB.
beforeEach(async () => {
  await getDb().delete(schema.schedules).where(eq(schema.schedules.organizationId, ORG));
  await getDb().delete(schema.scheduleAlerts).where(eq(schema.scheduleAlerts.organizationId, ORG));
});

async function schedule(over: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.schedules).values({
    id, organizationId: ORG, connectionId: null, name: `claim-${id.slice(0, 8)}`,
    operation: 'sync', kind: 'interval', intervalSeconds: 300,
    anchorAt: new Date(now), createdBy: 'test', ...over,
  });
  return id;
}

/** A due, unclaimed run — the shape the materializer leaves behind. */
async function run(scheduleId: string, slot: string, fireAtMs: number): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.scheduleRuns).values({
    id, scheduleId, organizationId: ORG, slot, fireAt: new Date(fireAtMs), state: 'pending',
  });
  return id;
}

/**
 * An `agent_prompt` schedule. `shape_matches_job_type` requires all five agent
 * columns and a NULL operation, so the fixture cannot be thinner than this.
 */
async function agentSchedule(over: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.schedules).values({
    id, organizationId: ORG, connectionId: null, name: `agent-${id.slice(0, 8)}`,
    jobType: 'agent_prompt', operation: null,
    agentPrompt: 'read the week and write one page',
    agentModel: 'claude-haiku-4-5', agentMaxTokens: 4096,
    agentBudgetUsd: '2', agentHarnessVersion: '2.1.274',
    kind: 'interval', intervalSeconds: 300, anchorAt: new Date(now),
    createdBy: 'test', ...over,
  });
  return id;
}

/** A run another worker already holds, with its lease still in the future. */
async function runningRun(
  scheduleId: string, slot: string, startedMs: number, leaseExpiresMs: number,
): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.scheduleRuns).values({
    id, scheduleId, organizationId: ORG, slot, fireAt: new Date(startedMs),
    state: 'running', claimedBy: 'other-worker',
    startedAt: new Date(startedMs), leaseExpiresAt: new Date(leaseExpiresMs),
  });
  return id;
}

const rowOf = async (runId: string) =>
  (await getDb().select().from(schema.scheduleRuns)
    .where(eq(schema.scheduleRuns.id, runId)))[0]!;

const alertsFor = (scheduleId: string) =>
  getDb().select().from(schema.scheduleAlerts)
    .where(eq(schema.scheduleAlerts.scheduleId, scheduleId));

describe('claiming', () => {
  test('claims the oldest due pending run and takes a lease', async () => {
    const id = await schedule({ timeoutSeconds: 120 });
    const older = await run(id, 's1', now - 600_000);
    await run(id, 's2', now - 300_000);
    const claimed = await claimNextRun('worker-a', now, SCHEDULER);
    expect(claimed).not.toBe('none');
    expect((claimed as ClaimedRun).run.id).toBe(older);
    expect((claimed as ClaimedRun).run.state).toBe('running');
    expect((claimed as ClaimedRun).run.claimedBy).toBe('worker-a');
    // lease = timeout + 60s of margin
    expect((claimed as ClaimedRun).run.leaseExpiresAt!.getTime()).toBe(now + 180_000);
  });

  test('never claims a run whose fire time has not arrived', async () => {
    const id = await schedule();
    await run(id, 'future', now + 600_000);
    expect(await claimNextRun('worker-a', now, SCHEDULER)).toBe('none');
  });

  test('two workers racing never claim the same run (SKIP LOCKED)', async () => {
    const id = await schedule({ overlapPolicy: 'queue' });
    await run(id, 'r1', now - 60_000);
    await run(id, 'r2', now - 50_000);
    const [a, b] = await Promise.all([
      claimNextRun('worker-a', now, SCHEDULER), claimNextRun('worker-b', now, SCHEDULER),
    ]);
    const ids = [a, b].filter((x): x is ClaimedRun => x !== 'none').map((x) => x.run.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });
});

describe('overlap policy', () => {
  test('skip: a second run while one is in flight is marked skipped_overlap', async () => {
    const id = await schedule({ overlapPolicy: 'skip' });
    await runningRun(id, 'in-flight', now - 60_000, now + 120_000);
    const next = await run(id, 'next', now - 10_000);
    expect(await claimNextRun('worker-a', now, SCHEDULER)).toBe('none');
    expect((await rowOf(next)).state).toBe('skipped_overlap');
  });

  test('queue: the run stays pending and is claimed once the first finishes', async () => {
    const id = await schedule({ overlapPolicy: 'queue' });
    const first = await runningRun(id, 'in-flight', now - 60_000, now + 120_000);
    const next = await run(id, 'next', now - 10_000);
    expect(await claimNextRun('worker-a', now, SCHEDULER)).toBe('none');
    expect((await rowOf(next)).state).toBe('pending');

    await finishRun(first, { state: 'succeeded', classification: 'ok', exitCode: 0 });
    const claimed = await claimNextRun('worker-a', now, SCHEDULER);
    expect((claimed as ClaimedRun).run.id).toBe(next);
  });

  test('queue is depth-capped: the oldest waiter is dropped with an alert', async () => {
    const id = await schedule({ overlapPolicy: 'queue' });
    await runningRun(id, 'in-flight', now - 60_000, now + 120_000);
    const waiters: string[] = [];
    // Distinct fire times: "the oldest waiter" is otherwise undefined among
    // ties, and the drop order would rest on an unspecified tie-break.
    for (let i = 0; i <= QUEUE_DEPTH_CAP; i++) waiters.push(await run(id, `w${i}`, now - 1000 + i));
    await claimNextRun('worker-a', now, SCHEDULER);
    expect((await rowOf(waiters[0]!)).state).toBe('skipped_overlap');
    const alerts = await alertsFor(id);
    expect(alerts.some((a) => a.kind === 'overlap_queue_full')).toBe(true);
  });

  test('kill_previous: the in-flight run is cancelled, then the new one is claimed', async () => {
    const id = await schedule({ overlapPolicy: 'kill_previous' });
    const first = await runningRun(id, 'in-flight', now - 60_000, now + 120_000);
    const next = await run(id, 'next', now - 10_000);
    const claimed = await claimNextRun('worker-a', now, SCHEDULER);
    expect((claimed as ClaimedRun).run.id).toBe(next);
    const previous = await rowOf(first);
    expect(previous.cancelRequested).toBe(true);
    expect(previous.state).toBe('cancelled');
    expect(previous.classification).toBe('cancelled');
  });
});

describe('leases', () => {
  test('heartbeat extends only the holder\'s own lease', async () => {
    const id = await schedule({ timeoutSeconds: 120 });
    const r = await run(id, 'h1', now - 1000);
    await claimNextRun('worker-a', now, SCHEDULER);
    expect(await heartbeat(r, 'worker-b', now + 30_000)).toBe(false);
    expect(await heartbeat(r, 'worker-a', now + 30_000)).toBe(true);
    expect((await rowOf(r)).leaseExpiresAt!.getTime()).toBe(now + 30_000 + 180_000);
  });

  test('an expired lease is reclaimed as lease_expired, alerted, and NEVER auto-retried', async () => {
    const id = await schedule({ timeoutSeconds: 120 });
    const r = await run(id, 'x1', now - 1000);
    await claimNextRun('worker-a', now, SCHEDULER);
    const reclaimed = await reclaimExpiredLeases(now + 10_000_000);
    expect(reclaimed).toBe(1);

    const row = await rowOf(r);
    expect(row.state).toBe('lease_expired');
    // D2: the command lane's behaviour is UNCHANGED by Slice 4 — `failed` is
    // still its word, and the reclaimer's new `infra_failed` is the agent
    // lane's (honesty rule 5).
    expect(row.classification).toBe('failed');
    expect(row.attempt).toBe(1); // a half-finished dream costs money; no silent re-run
    expect((await alertsFor(id)).some((a) => a.kind === 'lease_expired')).toBe(true);
    expect(await claimNextRun('worker-a', now + 10_000_000, SCHEDULER)).toBe('none');
  });
});

describe('the job-type filter (D2)', () => {
  test('each consumer sees only its own lane, and a wrong-type row at the head starves nobody', async () => {
    const command = await schedule();
    const agent = await agentSchedule();
    // The agent row is the OLDER one, so an unfiltered select would take it and
    // the scheduler would be blocked behind a row it can never execute.
    const agentRun = await run(agent, 'a1', now - 900_000);
    const commandRun = await run(command, 'c1', now - 600_000);

    const byScheduler = await claimNextRun('scheduler-worker', now, SCHEDULER);
    expect(byScheduler).not.toBe('none');
    expect((byScheduler as ClaimedRun).run.id).toBe(commandRun);
    // Untouched by the scheduler: not claimed, not skipped_overlap, no lease.
    expect(await rowOf(agentRun)).toMatchObject({
      state: 'pending', claimedBy: null, leaseExpiresAt: null,
    });

    const byRunner = await claimNextRun('runner-0123abcd', now, RUNNER);
    expect(byRunner).not.toBe('none');
    expect((byRunner as ClaimedRun).run.id).toBe(agentRun);
    expect((byRunner as ClaimedRun).run.claimedBy).toBe('runner-0123abcd');
  });

  test('a lane with nothing of its own answers none rather than taking the other lane\'s row', async () => {
    const command = await schedule();
    const commandRun = await run(command, 'only-command', now - 1000);
    expect(await claimNextRun('runner-0123abcd', now, RUNNER)).toBe('none');
    // Still claimable by the consumer that owns it: nothing was consumed or
    // marked skipped on the wrong lane's behalf.
    expect((await rowOf(commandRun)).state).toBe('pending');
    expect(await claimNextRun('scheduler-worker', now, SCHEDULER)).not.toBe('none');
  });
});

describe('reclaiming across both lanes (D2, honesty rules 5 and 9)', () => {
  test('an agent row is classified infra_failed in both vocabularies, and its token is claimed for revocation', async () => {
    const scheduleId = await agentSchedule({ timeoutSeconds: 120 });
    const runId = await run(scheduleId, 'agent-x1', now - 1000);
    await claimNextRun('runner-0123abcd', now, RUNNER);
    // The claim path inserts this row with the run's client id. A NULL id here
    // keeps the probe off the network: `revokeRunToken` still claims the stamp,
    // which is the row-level half of honesty rule 9 that this lane owns; the ops
    // kill itself is proven in agent-runs.test.ts against a mocked ops.
    await getDb().insert(schema.agentRuns).values({
      runId, organizationId: ORG, connectionId: null,
      model: 'claude-haiku-4-5', harnessVersion: '2.1.274', budgetUsd: '2',
      gbrainClientId: null,
    });

    expect(await reclaimExpiredLeases(now + 10_000_000)).toBe(1);

    expect(await rowOf(runId)).toMatchObject({
      state: 'lease_expired', classification: 'infra_failed',
    });
    const [agentRun] = await getDb().select().from(schema.agentRuns)
      .where(eq(schema.agentRuns.runId, runId));
    expect(agentRun!.failureClass).toBe('infra_failed');
    expect(agentRun!.failureDetail).toMatchObject({ reason: 'lease_expired' });
    expect(agentRun!.tokenRevokedAt).toBeInstanceOf(Date);

    const alerts = await alertsFor(scheduleId);
    const expired = alerts.find((a) => a.kind === 'lease_expired');
    expect(expired!.detail).toMatchObject({ jobType: 'agent_prompt' });
  });
});
