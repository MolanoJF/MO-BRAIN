import { test, expect, describe, beforeAll, beforeEach, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, pinDb, runMigrations, schema } from '../../src/control/db/client.ts';
import { tryAcquireLeadership } from '../../src/scheduler/leader.ts';
import { MAX_RUNS_PER_PASS, WORKER_ID, tickOnce } from '../../src/scheduler/main.ts';

const CONTROL_DATABASE_URL =
  process.env.CONTROL_DATABASE_URL ?? 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

// `getDb()` reads the variable lazily but never falls back on its own, so with
// nothing exported (bare `bun test test/unit`) the suite died on
// `CONTROL_DATABASE_URL is required` before the probe below could decide whether
// a Postgres is even there. Install the same default the other control-DB suites
// do at module load, ahead of `pinDb()` in beforeAll.
process.env.CONTROL_DATABASE_URL ??= CONTROL_DATABASE_URL;

const SCRATCH_PG_CMD =
  'docker run -d --name mobrain-fp-pg -e POSTGRES_USER=gbrain -e POSTGRES_PASSWORD=ci-not-a-real-secret ' +
  '-e POSTGRES_DB=control -p 5432:5432 pgvector/pgvector:pg16';

const SKIP_ENV = 'MOBRAIN_ALLOW_SKIP_SCHEDULER_MAIN';

/**
 * The whole suite wants a Postgres, not a container: `tickOnce` takes the
 * leadership pool as an argument but hands the actual work to `materializeDue`,
 * which reads the process-wide control-DB pool. So the probes below talk to the
 * real control DB — there is no way to prove "the lock gate held" without it.
 */
const postgresAvailable = await probePostgres();

async function probePostgres(): Promise<boolean> {
  const probe = postgres(CONTROL_DATABASE_URL, { connect_timeout: 3, max: 1 });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
}

const ORG = `org-${randomUUID()}`;
/**
 * Pinned well before every other scheduler suite's fixtures (claim pins
 * 2025-06-01, materialize uses 2026 dates). `tickOnce` is not scoped to an org —
 * it sweeps every enabled schedule and every expired lease globally — so a
 * "current" instant here would let this file materialize a sibling suite's
 * fixtures (or reclaim its in-flight runs) while it is mid-assertion.
 */
const now = Date.UTC(2025, 0, 1, 0, 0);

let sql: Sql;

beforeAll(async () => {
  if (!postgresAvailable) return;
  pinDb();
  await runMigrations();
  sql = postgres(CONTROL_DATABASE_URL, { max: 2 });
  await getDb().insert(schema.organizations).values({
    id: ORG, name: 'Main', slug: `main-${randomUUID().slice(0, 8)}`, timezone: 'UTC',
  });
});

afterAll(async () => {
  if (postgresAvailable) {
    await getDb().delete(schema.organizations).where(eq(schema.organizations.id, ORG));
    await closeDb();
  }
  if (sql) await sql.end();
});

beforeEach(async () => {
  if (!postgresAvailable) return;
  await getDb().delete(schema.schedules).where(eq(schema.schedules.organizationId, ORG));
});

/** An enabled interval schedule whose watermark sits one tick behind `now`. */
async function dueSchedule(): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.schedules).values({
    id, organizationId: ORG, connectionId: null, name: `main-${id.slice(0, 8)}`,
    operation: 'sync', kind: 'interval', intervalSeconds: 300,
    anchorAt: new Date(now - 3_600_000), lastMaterializedAt: new Date(now - 3_600_000),
    createdBy: 'test',
  });
  return id;
}

describe('scheduler service', () => {
  test('the Postgres-backed checks are not silently skipped', () => {
    if (postgresAvailable) return;
    if (process.env[SKIP_ENV] === '1') return;
    throw new Error(
      `Could not reach Postgres at ${CONTROL_DATABASE_URL}, so the tickOnce leadership gate ` +
        `was skipped rather than run. Start scratch Postgres:\n\n  ${SCRATCH_PG_CMD}\n\n` +
        `Or set ${SKIP_ENV}=1 to opt out explicitly.`,
    );
  });

  test('WORKER_ID is unique per process and carries the host', () => {
    expect(WORKER_ID).toMatch(/-[0-9a-f]{8}$/);
    // The prefix is the container/host name, so a claim can be traced back to
    // the replica that took it; the suffix keeps two replicas on one host apart.
    expect(WORKER_ID.startsWith(`${process.env.HOSTNAME ?? 'scheduler'}-`)).toBe(true);
  });

  test('MAX_RUNS_PER_PASS is bounded so shutdown is never far away', () => {
    // A drain may only ever be a handful of runs behind: an unbounded pass
    // would keep claiming past SIGTERM and blow through stop_grace_period.
    expect(Number.isInteger(MAX_RUNS_PER_PASS)).toBe(true);
    expect(MAX_RUNS_PER_PASS).toBeGreaterThanOrEqual(1);
    expect(MAX_RUNS_PER_PASS).toBeLessThanOrEqual(10);
  });

  test.skipIf(!postgresAvailable)('tickOnce does nothing when another process holds leadership', async () => {
    const scheduleId = await dueSchedule();
    const other = await tryAcquireLeadership(sql);
    expect(other).not.toBeNull();
    try {
      await tickOnce(sql, now);
    } finally {
      await other!.release();
    }
    const runs = await getDb().select().from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.scheduleId, scheduleId));
    expect(runs).toHaveLength(0);
  });

  test.skipIf(!postgresAvailable)('tickOnce materializes once leadership is free', async () => {
    // The positive control for the test above: without it, a tickOnce that did
    // nothing at all would "pass" the leadership gate.
    const scheduleId = await dueSchedule();
    await tickOnce(sql, now);
    const runs = await getDb().select().from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.scheduleId, scheduleId));
    expect(runs.length).toBeGreaterThan(0);
    // `skip` catch-up still records the occurrences it declined as
    // `skipped_catchup`, so the proof of work is the pending row.
    expect(runs.some((r) => r.state === 'pending')).toBe(true);
  });
});
