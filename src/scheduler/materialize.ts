import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../control/db/client.ts';
import { applyCatchup, occurrencesIn, type CatchupPolicy, type ScheduleSpec } from './occurrences.ts';
import { isValidTimeZone } from './time.ts';

type ScheduleRow = typeof schema.schedules.$inferSelect;

/**
 * A watermark older than this is clamped. A leader that has been down for a
 * month must not enumerate a month of 5-minute slots to then throw most of
 * them away — the catch-up policy decides what RUNS, this decides what is even
 * considered.
 */
export const MAX_LOOKBACK_MS = 7 * 86_400_000;

export type TickResult = { scheduleId: string; created: number; skipped: number; error?: string };

export function specOf(row: ScheduleRow): ScheduleSpec {
  if (row.kind === 'interval') {
    if (row.intervalSeconds == null || row.anchorAt == null) {
      throw new Error(`interval schedule ${row.id} is missing intervalSeconds/anchorAt`);
    }
    return { kind: 'interval', intervalSeconds: row.intervalSeconds, anchorMs: row.anchorAt.getTime() };
  }
  if (row.calendarHour == null || row.calendarMinute == null) {
    throw new Error(`calendar schedule ${row.id} is missing hour/minute`);
  }
  const days = Array.isArray(row.calendarDaysOfWeek)
    ? (row.calendarDaysOfWeek as unknown[]).filter((d): d is number => typeof d === 'number')
    : null;
  return {
    kind: 'calendar',
    hour: row.calendarHour,
    minute: row.calendarMinute,
    daysOfWeek: days,
    gapPolicy: row.gapPolicy as 'shift' | 'skip',
    ambiguousPolicy: row.ambiguousPolicy as 'first' | 'second' | 'both',
  };
}

/**
 * One leader tick. For each enabled schedule: enumerate the occurrences in
 * (last_materialized_at, now], split them by catch-up policy, and insert both
 * halves. Insert conflicts on (schedule_id, slot) are the idempotency key
 * doing its job — a second tick, a failover mid-tick and a restart all
 * converge, so onConflictDoNothing is correct rather than defensive.
 */
export async function materializeDue(
  nowMs: number, opts: { lookbackMs?: number } = {},
): Promise<TickResult[]> {
  const db = getDb();
  const schedules = await db.select().from(schema.schedules)
    .where(eq(schema.schedules.enabled, true));
  if (schedules.length === 0) return [];

  const orgIds = [...new Set(schedules.map((s) => s.organizationId))];
  const orgs = await db.select().from(schema.organizations)
    .where(inArray(schema.organizations.id, orgIds));
  const tzOf = new Map(orgs.map((o) => [o.id, o.timezone]));

  const lookback = opts.lookbackMs ?? MAX_LOOKBACK_MS;
  const results: TickResult[] = [];

  for (const row of schedules) {
    try {
      const tz = tzOf.get(row.organizationId) ?? 'UTC';
      if (!isValidTimeZone(tz)) throw new Error(`organization ${row.organizationId} has an invalid timezone: ${tz}`);

      const watermark = row.lastMaterializedAt?.getTime() ?? row.createdAt.getTime();
      const from = Math.max(watermark, nowMs - lookback);
      if (from >= nowMs) {
        results.push({ scheduleId: row.id, created: 0, skipped: 0 });
        continue;
      }

      const occurrences = occurrencesIn(tz, specOf(row), from, nowMs);
      const { run, skipped } = applyCatchup(
        occurrences, nowMs, row.misfireGraceSeconds * 1000,
        row.catchupPolicy as CatchupPolicy,
      );

      const values = [
        ...run.map((o) => ({ ...base(row, o), state: 'pending' as const })),
        ...skipped.map((o) => ({ ...base(row, o), state: 'skipped_catchup' as const })),
      ];

      let created = 0;
      if (values.length > 0) {
        const inserted = await db.insert(schema.scheduleRuns).values(values)
          .onConflictDoNothing({
            target: [schema.scheduleRuns.scheduleId, schema.scheduleRuns.slot],
          })
          .returning({ id: schema.scheduleRuns.id, state: schema.scheduleRuns.state });
        created = inserted.filter((r) => r.state === 'pending').length;
      }

      await db.update(schema.schedules)
        .set({ lastMaterializedAt: new Date(nowMs) })
        .where(eq(schema.schedules.id, row.id));

      results.push({
        scheduleId: row.id,
        created,
        skipped: values.length - created,
      });
    } catch (e) {
      // One malformed schedule must never wedge the tick for every other org.
      results.push({
        scheduleId: row.id, created: 0, skipped: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

function base(row: ScheduleRow, o: { fireAtMs: number; slot: string }) {
  return {
    id: randomUUID(),
    scheduleId: row.id,
    organizationId: row.organizationId,
    slot: o.slot,
    fireAt: new Date(o.fireAtMs),
  };
}
