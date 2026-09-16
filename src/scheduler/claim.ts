import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lt, lte, ne } from 'drizzle-orm';
import { getDb, schema } from '../control/db/client.ts';

type RunRow = typeof schema.scheduleRuns.$inferSelect;
type ScheduleRow = typeof schema.schedules.$inferSelect;

export type ClaimedRun = { run: RunRow; schedule: ScheduleRow };

/** A 'queue' overlap policy is a queue, not an unbounded backlog. */
export const QUEUE_DEPTH_CAP = 5;

/** Lease margin over the schedule's own timeout, so a slow run is not stolen. */
const LEASE_MARGIN_MS = 60_000;

const NON_TERMINAL = ['pending', 'running'] as const;

/**
 * Claim the oldest due run. FOR UPDATE SKIP LOCKED is what makes N workers
 * safe: a row another worker is mid-claim on is invisible rather than blocking,
 * so throughput scales with replicas and nothing double-runs.
 *
 * Overlap policy is evaluated HERE, not at materialize time, because "is
 * another run of this schedule in flight" is only knowable at claim time.
 */
export async function claimNextRun(workerId: string, nowMs: number): Promise<ClaimedRun | 'none'> {
  const db = getDb();
  const now = new Date(nowMs);

  // Transaction: the row stays locked from selection through the state write.
  return db.transaction(async (tx): Promise<ClaimedRun | 'none'> => {
    const [candidate] = await tx.select().from(schema.scheduleRuns)
      .where(and(
        eq(schema.scheduleRuns.state, 'pending'),
        lte(schema.scheduleRuns.fireAt, now),
      ))
      .orderBy(asc(schema.scheduleRuns.fireAt))
      .limit(1)
      .for('update', { skipLocked: true });

    if (!candidate) return 'none';

    const [schedule] = await tx.select().from(schema.schedules)
      .where(eq(schema.schedules.id, candidate.scheduleId));
    if (!schedule || !schedule.enabled) {
      await tx.update(schema.scheduleRuns)
        .set({ state: 'skipped_overlap', finishedAt: now, classification: 'refused' })
        .where(eq(schema.scheduleRuns.id, candidate.id));
      return 'none';
    }

    const inFlight = await tx.select().from(schema.scheduleRuns)
      .where(and(
        eq(schema.scheduleRuns.scheduleId, schedule.id),
        eq(schema.scheduleRuns.state, 'running'),
        ne(schema.scheduleRuns.id, candidate.id),
      ));

    if (inFlight.length > 0) {
      if (schedule.overlapPolicy === 'skip') {
        await tx.update(schema.scheduleRuns)
          .set({ state: 'skipped_overlap', finishedAt: now })
          .where(eq(schema.scheduleRuns.id, candidate.id));
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
    const [claimed] = await tx.update(schema.scheduleRuns)
      .set({
        state: 'running', claimedBy: workerId, startedAt: now,
        leaseExpiresAt: new Date(nowMs + leaseMs),
      })
      .where(eq(schema.scheduleRuns.id, candidate.id))
      .returning();

    return { run: claimed!, schedule };
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
 */
export async function reclaimExpiredLeases(nowMs: number): Promise<number> {
  const db = getDb();
  const expired = await db.update(schema.scheduleRuns)
    .set({
      state: 'lease_expired', classification: 'failed',
      finishedAt: new Date(nowMs), leaseExpiresAt: null,
    })
    .where(and(
      eq(schema.scheduleRuns.state, 'running'),
      lt(schema.scheduleRuns.leaseExpiresAt, new Date(nowMs)),
    ))
    .returning({
      id: schema.scheduleRuns.id,
      scheduleId: schema.scheduleRuns.scheduleId,
      organizationId: schema.scheduleRuns.organizationId,
      claimedBy: schema.scheduleRuns.claimedBy,
    });

  if (expired.length > 0) {
    await db.insert(schema.scheduleAlerts).values(expired.map((r) => ({
      id: randomUUID(), organizationId: r.organizationId, scheduleId: r.scheduleId,
      runId: r.id, kind: 'lease_expired',
      detail: { claimedBy: r.claimedBy, note: 'not retried — see honesty rule 6' },
    })));
  }
  return expired.length;
}
