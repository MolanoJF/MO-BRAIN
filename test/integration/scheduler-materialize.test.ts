import { test, expect, describe, beforeAll, beforeEach, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, pinDb, runMigrations, schema } from '../../src/control/db/client.ts';
import { materializeDue, type TickResult } from '../../src/scheduler/materialize.ts';

const ORG = `org-${randomUUID()}`;
/** Second org, used only by the isolation test below. */
const BROKEN_ORG = `org-${randomUUID()}`;
const NY = 'America/New_York';

beforeAll(async () => {
  pinDb();
  await runMigrations();
  await getDb().insert(schema.organizations).values({
    id: ORG, name: 'Sched', slug: `sched-${randomUUID().slice(0, 8)}`, timezone: NY,
  });
  await getDb().insert(schema.organizations).values({
    id: BROKEN_ORG, name: 'Broken', slug: `broken-${randomUUID().slice(0, 8)}`, timezone: NY,
  });
});
afterAll(async () => {
  await getDb().delete(schema.organizations).where(eq(schema.organizations.id, ORG));
  await getDb().delete(schema.organizations).where(eq(schema.organizations.id, BROKEN_ORG));
  await closeDb();
});
beforeEach(async () => {
  await getDb().delete(schema.schedules).where(eq(schema.schedules.organizationId, ORG));
});

const runsOf = (scheduleId: string) =>
  getDb().select().from(schema.scheduleRuns)
    .where(eq(schema.scheduleRuns.scheduleId, scheduleId))
    .orderBy(schema.scheduleRuns.fireAt);

async function interval(seconds: number, anchorMs: number, over: Record<string, unknown> = {}) {
  const id = randomUUID();
  await getDb().insert(schema.schedules).values({
    id, organizationId: ORG, connectionId: null, name: `iv-${id.slice(0, 8)}`,
    operation: 'sync', kind: 'interval', intervalSeconds: seconds,
    anchorAt: new Date(anchorMs), lastMaterializedAt: new Date(anchorMs),
    createdBy: 'test', ...over,
  });
  return id;
}

async function calendar(hour: number, minute: number, fromMs: number, over: Record<string, unknown> = {}) {
  const id = randomUUID();
  await getDb().insert(schema.schedules).values({
    id, organizationId: ORG, connectionId: null, name: `cal-${id.slice(0, 8)}`,
    operation: 'dream', kind: 'calendar', calendarHour: hour, calendarMinute: minute,
    calendarDaysOfWeek: null, slotMinute: minute, lastMaterializedAt: new Date(fromMs),
    createdBy: 'test', ...over,
  });
  return id;
}

/** The isolation test's broken row: a schedule in the org whose timezone is unresolvable. */
async function brokenSchedule(seconds: number, anchorMs: number) {
  const id = randomUUID();
  await getDb().insert(schema.schedules).values({
    id, organizationId: BROKEN_ORG, connectionId: null, name: `broken-${id.slice(0, 8)}`,
    operation: 'sync', kind: 'interval', intervalSeconds: seconds,
    anchorAt: new Date(anchorMs), lastMaterializedAt: new Date(anchorMs),
    misfireGraceSeconds: 3600, createdBy: 'test',
  });
  return id;
}

/**
 * `materializeDue` sweeps every enabled schedule in the database, and this
 * suite shares a scratch Postgres with the other scheduler suites, so the
 * result under test is selected by id rather than by position.
 */
const resultOf = (results: TickResult[], id: string) => results.find((r) => r.scheduleId === id);

/**
 * Drizzle wraps the server error, so the SQLSTATE and the constraint name live
 * on the cause chain. Flattening it keeps the assertion honest: a bare
 * `toContain` on the top-level message would pass on any failure at all.
 */
function errorChain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  while (cur instanceof Error && parts.length < 8) {
    parts.push(cur.message);
    const code: unknown = Reflect.get(cur, 'code');
    if (typeof code === 'string') parts.push(code);
    cur = cur.cause;
  }
  return parts.join(' | ');
}

describe('materializing due occurrences', () => {
  test('creates one run per occurrence and advances the watermark', async () => {
    const anchor = Date.UTC(2026, 8, 15, 12, 0);
    // The tick lands 15 minutes after the anchor, so a generous grace is what
    // makes all three occurrences "due now": this test is about enumeration,
    // insertion and the watermark, not about the grace window (the catch-up
    // suite below pins that behaviour with the 120s default).
    const id = await interval(300, anchor, { misfireGraceSeconds: 3600 });
    const result = resultOf(await materializeDue(anchor + 900_000), id)!;
    expect(result.created).toBe(3);

    const runs = await runsOf(id);
    expect(runs.map((r) => r.slot)).toEqual([
      '2026-09-15T08:05', '2026-09-15T08:10', '2026-09-15T08:15',
    ]); // 12:00Z = 08:00 EDT
    expect(runs.every((r) => r.state === 'pending')).toBe(true);

    const [after] = await getDb().select().from(schema.schedules).where(eq(schema.schedules.id, id));
    expect(after!.lastMaterializedAt!.getTime()).toBe(anchor + 900_000);
  });

  test('is idempotent — a repeated tick over the same window creates nothing', async () => {
    const anchor = Date.UTC(2026, 8, 15, 12, 0);
    const id = await interval(300, anchor);
    await materializeDue(anchor + 900_000);
    await getDb().update(schema.schedules)
      .set({ lastMaterializedAt: new Date(anchor) }).where(eq(schema.schedules.id, id));
    const second = resultOf(await materializeDue(anchor + 900_000), id)!;
    expect(second.created).toBe(0);
    expect((await runsOf(id)).length).toBe(3);
  });

  test('fires on time across the fall-back boundary with unique slots', async () => {
    const anchor = Date.UTC(2026, 10, 1, 4, 55);
    const id = await interval(300, anchor);
    await materializeDue(Date.UTC(2026, 10, 1, 7, 5));

    const runs = await runsOf(id);
    expect(runs.length).toBe(26);
    expect(new Set(runs.map((r) => r.slot)).size).toBe(26);
    expect(runs.filter((r) => r.slot.endsWith('#2')).length).toBe(12);
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]!.fireAt.getTime() - runs[i - 1]!.fireAt.getTime()).toBe(300_000);
    }
  });

  test('fires on time across the spring-forward gap with no 02:xx slots', async () => {
    const anchor = Date.UTC(2026, 2, 8, 6, 50);
    const id = await interval(300, anchor);
    await materializeDue(Date.UTC(2026, 2, 8, 7, 30));

    const runs = await runsOf(id);
    const slots = runs.map((r) => r.slot);
    expect(slots).toContain('2026-03-08T01:55');
    expect(slots).toContain('2026-03-08T03:00');
    expect(slots.some((s) => s.startsWith('2026-03-08T02:'))).toBe(false);
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]!.fireAt.getTime() - runs[i - 1]!.fireAt.getTime()).toBe(300_000);
    }
  });

  test('a calendar job at a nonexistent 02:30 shifts to 03:30 and fires once', async () => {
    const id = await calendar(2, 30, Date.UTC(2026, 2, 8, 0, 0), { slotMinute: 30 });
    await materializeDue(Date.UTC(2026, 2, 8, 23, 0));
    const runs = await runsOf(id);
    expect(runs.length).toBe(1);
    expect(runs[0]!.slot).toBe('2026-03-08T03:30');
    expect(runs[0]!.fireAt.getTime()).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });

  test('a calendar job at an ambiguous 01:30 fires exactly once, not twice', async () => {
    const id = await calendar(1, 30, Date.UTC(2026, 10, 1, 0, 0), { slotMinute: 30 });
    await materializeDue(Date.UTC(2026, 10, 1, 23, 0));
    const runs = await runsOf(id);
    expect(runs.length).toBe(1);
    expect(runs[0]!.fireAt.getTime()).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });
});

describe('catch-up after downtime', () => {
  const anchor = Date.UTC(2026, 8, 15, 12, 0);
  const now = anchor + 3_600_000; // one hour of downtime, 12 missed 5-min slots

  test('default skip records the misses but runs none of them', async () => {
    const id = await interval(300, anchor);
    await materializeDue(now);
    const runs = await runsOf(id);
    const pending = runs.filter((r) => r.state === 'pending');
    const skipped = runs.filter((r) => r.state === 'skipped_catchup');
    expect(pending.length).toBe(1);               // only the one inside the grace window
    expect(skipped.length).toBe(11);
    // "why didn't my job run last night" must be answerable from history.
    expect(skipped.every((r) => r.classification === null)).toBe(true);
  });

  test('run_latest runs exactly one missed occurrence — the most recent', async () => {
    const id = await interval(300, anchor, { catchupPolicy: 'run_latest' });
    await materializeDue(now);
    const runs = await runsOf(id);
    const pending = runs.filter((r) => r.state === 'pending');
    expect(pending.length).toBe(2);
    expect(pending[0]!.fireAt.getTime()).toBe(now - 300_000);
  });

  test('run_all runs every missed occurrence, capped', async () => {
    const id = await interval(300, anchor, { catchupPolicy: 'run_all' });
    await materializeDue(now);
    const runs = await runsOf(id);
    expect(runs.filter((r) => r.state === 'pending').length).toBe(12);
    expect(runs.filter((r) => r.state === 'skipped_catchup').length).toBe(0);
  });
});

describe('safety rails', () => {
  test('a disabled schedule materializes nothing', async () => {
    const anchor = Date.UTC(2026, 8, 15, 12, 0);
    const id = await interval(300, anchor, { enabled: false, disabledReason: 'connection_revoked' });
    const results = await materializeDue(anchor + 900_000);
    expect(results.find((r) => r.scheduleId === id)).toBeUndefined();
    expect((await runsOf(id)).length).toBe(0);
  });

  test('a very stale watermark is clamped, not enumerated for a year', async () => {
    const anchor = Date.UTC(2025, 0, 1, 0, 0);
    // 600s, not 300s: a 7-day lookback window at 5-minute granularity is 2016
    // occurrences, which MAX_OCCURRENCES_PER_TICK (2000) itself rejects. The
    // subject here is the watermark clamp, so the fixture stays under the cap
    // and an unclamped watermark still blows through it.
    const id = await interval(600, anchor);
    const result = resultOf(await materializeDue(Date.UTC(2026, 8, 15, 12, 0)), id)!;
    expect(result.error).toBeUndefined();
    // Clamped to the lookback window, so the count is bounded and finite.
    expect(result.created + result.skipped).toBeLessThanOrEqual(2000);
    expect((await runsOf(id)).length).toBeGreaterThan(0);
  });

  test('one broken schedule does not stop the others', async () => {
    const anchor = Date.UTC(2026, 8, 15, 12, 0);
    // The plan's corruption is un-forceable: shape_matches_kind refuses an
    // interval row with a null interval_seconds (SQLSTATE 23514), and that
    // refusal is asserted rather than swallowed. The broken row is therefore
    // the plan's fallback — a schedule whose org has an unusable timezone.
    const broken = await brokenSchedule(300, anchor);
    let refusal: unknown;
    try {
      await getDb().execute(
        sql`update schedules set interval_seconds = null, kind = 'interval' where id = ${broken}`,
      );
    } catch (e) {
      refusal = e;
    }
    expect(errorChain(refusal)).toContain('shape_matches_kind');
    expect(errorChain(refusal)).toContain('23514');

    await getDb().update(schema.organizations)
      .set({ timezone: 'Not/AZone' }).where(eq(schema.organizations.id, BROKEN_ORG));

    const good = await interval(300, anchor, { misfireGraceSeconds: 3600 });
    const results = await materializeDue(anchor + 600_000);
    expect(resultOf(results, good)!.created).toBe(2);
    expect((await runsOf(good)).map((r) => r.state)).toEqual(['pending', 'pending']);
    // The bad row is reported as an error, not thrown: the tick still completed.
    expect(resultOf(results, broken)!.error).toContain('invalid timezone');
    expect((await runsOf(broken)).length).toBe(0);
  });
});
