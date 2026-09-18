import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import { getDb, schema } from '../control/db/client.ts';
import { revokeRunToken } from '../agent/token.ts';

type RunRow = typeof schema.scheduleRuns.$inferSelect;
type ScheduleRow = typeof schema.schedules.$inferSelect;

export type ClaimedRun = { run: RunRow; schedule: ScheduleRow };

/**
 * D2 — ONE queue, two consumers. `schedule_runs` is the single run ledger;
 * `schedules.job_type` decides who may claim a row. This list is the same set
 * `job_type_valid` permits (Task 4's CHECK), and Gate A asserts that the two
 * consumers' sets cover it exactly: a row neither consumer can claim is a bug.
 */
export const JOB_TYPES = ['gbrain_command', 'agent_prompt'] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** A 'queue' overlap policy is a queue, not an unbounded backlog. */
export const QUEUE_DEPTH_CAP = 5;

/** Lease margin over the schedule's own timeout, so a slow run is not stolen. */
const LEASE_MARGIN_MS = 60_000;

const NON_TERMINAL = ['pending', 'running'] as const;

/**
 * Claim the oldest due run **of the job types this consumer owns**. FOR UPDATE
 * SKIP LOCKED is what makes N workers safe: a row another worker is mid-claim on
 * is invisible rather than blocking, so throughput scales with replicas and
 * nothing double-runs.
 *
 * `opts.jobTypes` is applied INSIDE that select — joined onto `schedules`, with
 * the row lock taken `of schedule_runs` alone (D2). A row of the wrong type is
 * therefore never locked, never counted against the queue cap and never starves
 * the other consumer: the scheduler passes `['gbrain_command']`, `/api/runs/claim`
 * passes `['agent_prompt']`, and a row at the head of the fire-time order that
 * belongs to the other lane is simply invisible to this query.
 *
 * Overlap policy is evaluated HERE, not at materialize time, because "is
 * another run of this schedule in flight" is only knowable at claim time.
 */
export async function claimNextRun(
  workerId: string,
  nowMs: number,
  opts: { jobTypes: readonly JobType[] },
): Promise<ClaimedRun | 'none'> {
  const db = getDb();
  const now = new Date(nowMs);

  // Transaction: the row stays locked from selection through the state write.
  return db.transaction(async (tx): Promise<ClaimedRun | 'none'> => {
    const [candidate] = await tx.select({ run: schema.scheduleRuns })
      .from(schema.scheduleRuns)
      .innerJoin(schema.schedules, eq(schema.schedules.id, schema.scheduleRuns.scheduleId))
      .where(and(
        eq(schema.scheduleRuns.state, 'pending'),
        lte(schema.scheduleRuns.fireAt, now),
        inArray(schema.schedules.jobType, [...opts.jobTypes]),
      ))
      .orderBy(asc(schema.scheduleRuns.fireAt))
      .limit(1)
      .for('update', { skipLocked: true, of: schema.scheduleRuns });

    if (!candidate) return 'none';
    const claimed = candidate.run;

    const [schedule] = await tx.select().from(schema.schedules)
      .where(eq(schema.schedules.id, claimed.scheduleId));
    if (!schedule || !schedule.enabled) {
      await tx.update(schema.scheduleRuns)
        .set({ state: 'skipped_overlap', finishedAt: now, classification: 'refused' })
        .where(eq(schema.scheduleRuns.id, claimed.id));
      return 'none';
    }

    const inFlight = await tx.select().from(schema.scheduleRuns)
      .where(and(
        eq(schema.scheduleRuns.scheduleId, schedule.id),
        eq(schema.scheduleRuns.state, 'running'),
        ne(schema.scheduleRuns.id, claimed.id),
      ));

    if (inFlight.length > 0) {
      if (schedule.overlapPolicy === 'skip') {
        await tx.update(schema.scheduleRuns)
          .set({ state: 'skipped_overlap', finishedAt: now })
          .where(eq(schema.scheduleRuns.id, claimed.id));
        return 'none';
      }

      if (schedule.overlapPolicy === 'queue') {
        const waiting = await tx.select({ id: schema.scheduleRuns.id })
          .from(schema.scheduleRuns)
          .where(and(
            eq(schema.scheduleRuns.scheduleId, schedule.id),
            eq(schema.scheduleRuns.state, 'pending'),
          ))
          .orderBy(asc(schema.scheduleRuns.fireAt));
        if (waiting.length > QUEUE_DEPTH_CAP) {
          const drop = waiting.slice(0, waiting.length - QUEUE_DEPTH_CAP).map((w) => w.id);
          await tx.update(schema.scheduleRuns)
            .set({ state: 'skipped_overlap', finishedAt: now })
            .where(inArray(schema.scheduleRuns.id, drop));
          await tx.insert(schema.scheduleAlerts).values({
            id: randomUUID(), organizationId: schedule.organizationId, scheduleId: schedule.id,
            runId: null, kind: 'overlap_queue_full',
            detail: { dropped: drop.length, cap: QUEUE_DEPTH_CAP },
          });
        }
        return 'none'; // leave the survivors pending; the next tick retries
      }

      // kill_previous: cancel in flight, then take the slot. The executor's
      // heartbeat observes cancel_requested and asks ops to SIGTERM the child.
      const ids = inFlight.map((r) => r.id);
      await tx.update(schema.scheduleRuns)
        .set({
          cancelRequested: true, state: 'cancelled', classification: 'cancelled',
          finishedAt: now,
        })
        .where(inArray(schema.scheduleRuns.id, ids));
      await tx.insert(schema.scheduleAlerts).values({
        id: randomUUID(), organizationId: schedule.organizationId, scheduleId: schedule.id,
        runId: ids[0] ?? null, kind: 'overlap_killed_previous',
        detail: { cancelled: ids.length },
      });
    }

    const leaseMs = schedule.timeoutSeconds * 1000 + LEASE_MARGIN_MS;
    const [taken] = await tx.update(schema.scheduleRuns)
      .set({
        state: 'running', claimedBy: workerId, startedAt: now,
        leaseExpiresAt: new Date(nowMs + leaseMs),
      })
      .where(eq(schema.scheduleRuns.id, claimed.id))
      .returning();

    return { run: taken!, schedule };
  });
}

/** Extend the lease. Only the holder may; a stale worker must lose the race. */
export async function heartbeat(runId: string, workerId: string, nowMs: number): Promise<boolean> {
  const [schedule] = await getDb().select({ timeoutSeconds: schema.schedules.timeoutSeconds })
    .from(schema.scheduleRuns)
    .innerJoin(schema.schedules, eq(schema.schedules.id, schema.scheduleRuns.scheduleId))
    .where(eq(schema.scheduleRuns.id, runId));
  if (!schedule) return false;

  const updated = await getDb().update(schema.scheduleRuns)
    .set({ leaseExpiresAt: new Date(nowMs + schedule.timeoutSeconds * 1000 + LEASE_MARGIN_MS) })
    .where(and(
      eq(schema.scheduleRuns.id, runId),
      eq(schema.scheduleRuns.claimedBy, workerId),
      eq(schema.scheduleRuns.state, 'running'),
    ))
    .returning({ id: schema.scheduleRuns.id });
  return updated.length > 0;
}

export async function finishRun(
  runId: string,
  patch: Partial<Pick<RunRow, 'state' | 'classification' | 'exitCode' | 'reportPath' | 'summary'>>,
): Promise<void> {
  await getDb().update(schema.scheduleRuns)
    .set({ ...patch, finishedAt: new Date(), leaseExpiresAt: null })
    .where(eq(schema.scheduleRuns.id, runId));
}

/**
 * A dead worker's run is reclaimed, alerted, and NOT retried. Honesty rule 6:
 * a half-finished `dream` has already spent real money; silently re-running it
 * is worse than leaving the next scheduled occurrence to do the work.
 *
 * **D2's "everything else is untouched" narrows here, and this is the narrow.**
 * The reclaimer is the only component that can react to a run whose runner is
 * gone, so for an `agent_prompt` row it does three things a `gbrain_command` row
 * does not (honesty rules 5 and 9):
 *
 *   1. it reads the row's job type, so it can tell the two lanes apart at all;
 *   2. it classifies the reclaimed agent run `infra_failed` — the word honesty
 *      rule 5 uses — in BOTH vocabularies: `schedule_runs.classification` here
 *      and `agent_runs.failure_class` below (L14: the reason lives on the row);
 *   3. it revokes the dead run's gbrain token through `revokeRunToken`. "A dead
 *      runner's run is not a finished run… revoked by the reclaimer, not by the
 *      process that died." That needs `agent_runs.gbrain_client_id`, which is
 *      why the claim path persists it in the same row as the run.
 *
 * A `gbrain_command` row's behaviour is byte-for-byte what it was: state
 * `lease_expired`, classification `failed`, one alert, no re-run. And a refused
 * token revocation does not fail the reclaim — the classification and the alert
 * are already written, and the failure is recorded in the alert's detail rather
 * than thrown away with it.
 */
export async function reclaimExpiredLeases(nowMs: number): Promise<number> {
  const db = getDb();
  // UPDATE … FROM schedules: one statement, so two reclaimers still cannot
  // double-stamp a row (the second re-evaluates its WHERE and finds no match).
  const expired = await db.update(schema.scheduleRuns)
    .set({
      state: 'lease_expired',
      classification: sql`case when ${schema.schedules.jobType} = 'agent_prompt'
        then 'infra_failed' else 'failed' end`,
      finishedAt: new Date(nowMs),
      leaseExpiresAt: null,
    })
    .from(schema.schedules)
    .where(and(
      eq(schema.scheduleRuns.scheduleId, schema.schedules.id),
      eq(schema.scheduleRuns.state, 'running'),
      lt(schema.scheduleRuns.leaseExpiresAt, new Date(nowMs)),
    ))
    .returning({
      id: schema.scheduleRuns.id,
      scheduleId: schema.scheduleRuns.scheduleId,
      organizationId: schema.scheduleRuns.organizationId,
      claimedBy: schema.scheduleRuns.claimedBy,
      jobType: schema.schedules.jobType,
    });

  if (expired.length === 0) return 0;

  const agentRuns = expired.filter((r) => r.jobType === 'agent_prompt');

  // Per row, because each carries its own `claimed_by` and its own revoke
  // outcome — and because the two lanes must not be able to write each other's
  // vocabulary. Revocation happens AFTER the stamp: the reclaim completes even
  // when ops is unreachable, since the classification is already durable and
  // only the alert's detail carries the failure.
  const revokeErrors = new Map<string, string>();
  for (const r of agentRuns) {
    // The failure class wins over nothing: a class the meter already recorded
    // (`budget_exceeded`, `refused`) is the one that witnessed the cause and is
    // never overwritten (L14; `classifyAgentExit` returns a recorded class
    // unchanged for the same reason).
    await db.update(schema.agentRuns)
      .set({
        failureClass: 'infra_failed',
        failureDetail: {
          reason: 'lease_expired',
          claimedBy: r.claimedBy,
          note: 'a dead runner\'s run is not a finished run (honesty rule 5)',
        },
      })
      .where(and(
        eq(schema.agentRuns.runId, r.id),
        isNull(schema.agentRuns.failureClass),
      ));

    try {
      await revokeRunToken(r.id);
    } catch (e) {
      revokeErrors.set(r.id, e instanceof Error ? e.message : String(e));
    }
  }

  await db.insert(schema.scheduleAlerts).values(expired.map((r) => ({
    id: randomUUID(), organizationId: r.organizationId, scheduleId: r.scheduleId,
    runId: r.id, kind: 'lease_expired',
    detail: r.jobType === 'agent_prompt'
      ? {
        jobType: r.jobType,
        claimedBy: r.claimedBy,
        note: 'classified infra_failed and its gbrain token revoked by the reclaimer — '
          + 'the process that died does not get to revoke it (honesty rules 5, 9)',
        ...(revokeErrors.has(r.id) ? { tokenRevokeError: revokeErrors.get(r.id)! } : {}),
      }
      : {
        jobType: r.jobType,
        claimedBy: r.claimedBy,
        note: 'not retried — see honesty rule 6',
      },
  })));

  return expired.length;
}
