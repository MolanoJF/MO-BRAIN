import { test, expect, describe, beforeAll, beforeEach, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, pinDb, runMigrations, schema } from '../../src/control/db/client.ts';
import { drainHeldNotifications } from '../../src/scheduler/briefing.ts';
import { executeRun, type ExecuteDeps } from '../../src/scheduler/execute.ts';
import type { ClaimedRun } from '../../src/scheduler/claim.ts';
import type { writeReport } from '../../src/control/opsClient.ts';

/**
 * The briefing drain against a REAL control DB with STUBBED ExecuteDeps: no
 * gbrain, no ops RPC, no spend. Held rows are inserted directly, because the
 * hold half of quiet hours is `test/integration/scheduler-execute.test.ts`'s
 * subject; this file is about what releases them.
 */
const ORG = `org-${randomUUID()}`;
const OTHER_ORG = `org-${randomUUID()}`;
/** No held rows ever land here: the empty-drain case. */
const EMPTY_ORG = `org-${randomUUID()}`;

/** 2026-09-15T12:00Z — 08:00 America/New_York, the briefing's own hour. */
const BRIEFING_MS = Date.UTC(2026, 8, 15, 12, 0);

type WriteArgs = Parameters<typeof writeReport>[0];
type Fixture = { user: string; email: string; membership: string; space: string; connection: string };

async function seedOrg(orgId: string): Promise<Fixture> {
  const db = getDb();
  const user = `user-${randomUUID()}`;
  const email = `briefing-${user}@test.local`;
  const membership = `mem-${randomUUID()}`;
  const space = `space-${randomUUID()}`;
  const connection = `conn-${randomUUID()}`;

  await db.insert(schema.users).values({ id: user, name: 'Briefing Member', email });
  await db.insert(schema.organizations).values({
    id: orgId, name: 'Briefing', slug: `brief-${randomUUID().slice(0, 8)}`,
    timezone: 'America/New_York', quietHoursStart: 23, quietHoursEnd: 8,
  });
  await db.insert(schema.memberships).values({
    id: membership, userId: user, organizationId: orgId, role: 'member',
  });
  await db.insert(schema.spaces).values({
    id: space, organizationId: orgId, sourceId: 'shared', name: 'Shared',
  });
  await db.insert(schema.connections).values({
    id: connection, organizationId: orgId, membershipId: membership, writeSpaceId: space,
    harness: 'claude-code', clientName: `bs-${connection.slice(0, 8)}-shared`, profile: 'default',
    tokenTtl: 3600, state: 'active',
  });

  return { user, email, membership, space, connection };
}

let org: Fixture;
let otherOrg: Fixture;

beforeAll(async () => {
  pinDb();
  await runMigrations();
  org = await seedOrg(ORG);
  otherOrg = await seedOrg(OTHER_ORG);
});

afterAll(async () => {
  // Cascades schedules, runs, alerts and held notifications away with each org.
  for (const fixture of [org, otherOrg]) {
    await getDb().delete(schema.organizations).where(eq(schema.organizations.id,
      fixture === org ? ORG : OTHER_ORG));
    await getDb().delete(schema.users).where(eq(schema.users.id, fixture.user));
  }
  await closeDb();
});

beforeEach(async () => {
  await getDb().delete(schema.schedules).where(eq(schema.schedules.organizationId, ORG));
  await getDb().delete(schema.scheduleAlerts).where(eq(schema.scheduleAlerts.organizationId, ORG));
  await getDb().delete(schema.heldNotifications)
    .where(eq(schema.heldNotifications.organizationId, ORG));
  await getDb().delete(schema.heldNotifications)
    .where(eq(schema.heldNotifications.organizationId, OTHER_ORG));
});

/** The row quiet hours would have written: the report is on disk, this points at it. */
async function hold(
  orgId: string, scheduleName: string, runId: string, headline: string,
  reportPath: string | null = null,
): Promise<void> {
  await getDb().insert(schema.heldNotifications).values({
    id: randomUUID(), organizationId: orgId, scheduleId: null, runId, scheduleName, reportPath,
    headline: `${scheduleName} — ${headline}`,
  });
}

const heldRowsOf = async (orgId: string) =>
  getDb().select().from(schema.heldNotifications)
    .where(eq(schema.heldNotifications.organizationId, orgId));

describe('the briefing drain', () => {
  test('drains everything held, once', async () => {
    await hold(ORG, 'live-sync', 'run-a', 'failed');
    await hold(ORG, 'nightly-dream', 'run-b', 'ok');

    const first = await drainHeldNotifications(ORG, 'briefing-run', BRIEFING_MS);
    expect(first.released).toBe(2);
    expect(first.body).toContain('live-sync');
    expect(first.body).toContain('nightly-dream');

    // Nothing is released twice — this is the "held messages MUST be picked up"
    // invariant and its dual: they must not be picked up twice.
    const second = await drainHeldNotifications(ORG, 'briefing-run-2', BRIEFING_MS + 1000);
    expect(second.released).toBe(0);

    // And the stamp names the run they went out with, not just "some run".
    const rows = await heldRowsOf(ORG);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.releasedAt?.getTime()).toBe(BRIEFING_MS);
      expect(row.releasedIntoRunId).toBe('briefing-run');
    }
  });

  test("another org's held output is never drained", async () => {
    await hold(ORG, 'live-sync', 'run-a', 'failed');
    await hold(OTHER_ORG, 'weekly-health', 'run-c', 'failed');

    const mine = await drainHeldNotifications(ORG, 'briefing-run', BRIEFING_MS);
    expect(mine.released).toBe(1);
    expect(mine.body).toContain('live-sync');
    expect(mine.body).not.toContain('weekly-health');

    // The other org's row is untouched, and its own briefing still gets it.
    const theirs = await drainHeldNotifications(OTHER_ORG, 'other-briefing-run', BRIEFING_MS);
    expect(theirs.released).toBe(1);
    expect(theirs.body).toContain('weekly-health');
  });

  test('an empty drain still produces a report body, not an empty file', async () => {
    const r = await drainHeldNotifications(EMPTY_ORG, 'run-x', BRIEFING_MS);

    expect(r.released).toBe(0);
    expect(r.body.trim().length).toBeGreaterThan(0);
  });
});

describe('the briefing schedule', () => {
  async function briefingSchedule(over: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await getDb().insert(schema.schedules).values({
      id, organizationId: ORG, connectionId: org.connection,
      name: 'morning-briefing', preset: 'morning-briefing', operation: 'morning-briefing',
      kind: 'calendar', calendarHour: 8, calendarMinute: 5, slotMinute: 5,
      reportPolicy: 'always', timeoutSeconds: 300, createdBy: 'test', ...over,
    });
    return id;
  }

  /** The pair `claimNextRun` would have handed the worker. */
  async function occurrence(scheduleId: string): Promise<ClaimedRun> {
    const db = getDb();
    const id = randomUUID();
    await db.insert(schema.scheduleRuns).values({
      id, scheduleId, organizationId: ORG, slot: `2026-09-15-0800-${id.slice(0, 8)}`,
      fireAt: new Date(BRIEFING_MS), state: 'running', claimedBy: 'worker-test',
      startedAt: new Date(BRIEFING_MS), leaseExpiresAt: new Date(BRIEFING_MS + 600_000),
    });
    const [run] = await db.select().from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.id, id));
    const [sched] = await db.select().from(schema.schedules)
      .where(eq(schema.schedules.id, scheduleId));
    return { run: run!, schedule: sched! };
  }

  /**
   * A gbrain call from a briefing is a bug, not a slow path: the stub records
   * the op and throws, so an accidental lookup fails its test loudly.
   */
  function harness() {
    const ops: string[] = [];
    const writes: WriteArgs[] = [];
    const deps: ExecuteDeps = {
      now: () => BRIEFING_MS,
      cancelRun: async () => ({ cancelled: false }),
      writeReport: (async (args: WriteArgs) => {
        writes.push(args);
        return { relPath: `reports/${args.job}/${args.stamp}.md`, committed: true, sha: 'test-sha' };
      }) as ExecuteDeps['writeReport'],
      callOps: (async (op: string) => {
        ops.push(op);
        throw new Error(`the briefing must not call gbrain (${op})`);
      }) as unknown as ExecuteDeps['callOps'],
    };
    return { deps, ops, writes };
  }

  const rowOf = async (runId: string) =>
    (await getDb().select().from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.id, runId)))[0]!;

  const alertKinds = async () =>
    (await getDb().select({ kind: schema.scheduleAlerts.kind }).from(schema.scheduleAlerts)
      .where(eq(schema.scheduleAlerts.organizationId, ORG))).map((a) => a.kind);

  test('the briefing run writes a report containing the released items', async () => {
    const scheduleId = await briefingSchedule();
    await hold(ORG, 'live-sync', 'run-a', 'failed', 'reports/live-sync/2026-09-15-0300.md');
    await hold(ORG, 'nightly-dream', 'run-b', 'ok');
    const claimed = await occurrence(scheduleId);
    const { deps, ops, writes } = harness();

    const result = await executeRun(claimed, deps);

    expect(result.classification).toBe('ok');
    expect(ops).toEqual([]);
    expect(writes.length).toBe(1);
    const writtenBody = writes[0]!.reportBody;
    expect(writtenBody).toContain('Overnight updates');
    expect(writtenBody).toContain('live-sync');
    expect(writtenBody).toContain('nightly-dream');
    // The held report is still reachable: the briefing links it, it does not copy it.
    expect(writtenBody).toContain('reports/live-sync/2026-09-15-0300.md');

    // The Connection still decides where the report lands and who signs it.
    expect(writes[0]!.sourceId).toBe('shared');
    expect(writes[0]!.job).toBe('morning-briefing');
    expect(writes[0]!.actor).toEqual({ name: 'Briefing Member', email: org.email });
    // The stamp is the ORG-LOCAL wall clock of the slot: 08:00 EDT.
    expect(writes[0]!.stamp).toBe('2026-09-15-0800');

    const row = await rowOf(claimed.run.id);
    expect(row.state).toBe('succeeded');
    expect(row.classification).toBe('ok');
    expect(row.reportPath).toBe(result.reportPath);
    expect(row.summary).toEqual({ released: 2 });

    // The drain is stamped against THIS run, and a briefing never raises an alert.
    for (const held of await heldRowsOf(ORG)) {
      expect(held.releasedAt?.getTime()).toBe(BRIEFING_MS);
      expect(held.releasedIntoRunId).toBe(claimed.run.id);
    }
    expect(await alertKinds()).toEqual([]);
  });

  test('a briefing whose Connection is revoked refuses and releases nothing', async () => {
    const revoked = `conn-${randomUUID()}`;
    await getDb().insert(schema.connections).values({
      id: revoked, organizationId: ORG, membershipId: org.membership, writeSpaceId: org.space,
      harness: 'claude-code', clientName: `bs-${revoked.slice(0, 8)}-shared`, profile: 'default',
      tokenTtl: 3600, state: 'revoked',
    });
    const scheduleId = await briefingSchedule({ connectionId: revoked });
    await hold(ORG, 'live-sync', 'run-a', 'failed');
    const claimed = await occurrence(scheduleId);
    const { deps, ops, writes } = harness();

    const result = await executeRun(claimed, deps);

    // No gbrain call to make, but also no write Space to release into: refusing
    // BEFORE the drain is what keeps the held row held for the next briefing.
    expect(result.classification).toBe('refused');
    expect(ops).toEqual([]);
    expect(writes).toEqual([]);
    expect((await rowOf(claimed.run.id)).state).toBe('failed');
    expect(await alertKinds()).toEqual(['run_refused']);

    const rows = await heldRowsOf(ORG);
    expect(rows.length).toBe(1);
    expect(rows[0]!.releasedAt).toBeNull();
    expect(rows[0]!.releasedIntoRunId).toBeNull();
  });

  test('the drain skips rows an earlier briefing already released', async () => {
    await hold(ORG, 'live-sync', 'run-a', 'failed');
    await drainHeldNotifications(ORG, 'earlier-briefing', BRIEFING_MS - 86_400_000);
    await hold(ORG, 'nightly-dream', 'run-b', 'ok');
    const claimed = await occurrence(await briefingSchedule());
    const { deps, writes } = harness();

    const result = await executeRun(claimed, deps);

    expect(result.classification).toBe('ok');
    expect(writes[0]!.reportBody).toContain('nightly-dream');
    expect(writes[0]!.reportBody).not.toContain('live-sync');
    expect((await rowOf(claimed.run.id)).summary).toEqual({ released: 1 });

    const earlier = (await heldRowsOf(ORG))
      .filter((r) => r.releasedIntoRunId === 'earlier-briefing');
    expect(earlier.length).toBe(1);
    expect(earlier[0]!.releasedAt?.getTime()).toBe(BRIEFING_MS - 86_400_000);
  });
});
