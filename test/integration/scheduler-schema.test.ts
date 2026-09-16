import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, pinDb, runMigrations, schema } from '../../src/control/db/client.ts';

const ORG = `org-${randomUUID()}`;

beforeAll(async () => {
  pinDb();
  await runMigrations();
  await getDb().insert(schema.organizations).values({
    id: ORG, name: 'Sched Test', slug: `sched-${randomUUID().slice(0, 8)}`,
  });
});

afterAll(async () => {
  await getDb().delete(schema.organizations).where(sql`id = ${ORG}`);
  await closeDb();
});

/**
 * Drizzle's query promise hangs under `expect(...).rejects` in this bun — the
 * same trap `test/integration/schema.test.ts` documents for bun's own SQL
 * objects. Refusals are therefore asserted through try/catch, and pinned
 * harder than `toThrow()`: to the Postgres SQLSTATE and the constraint that
 * fired, so a refusal for the wrong reason cannot pass.
 */
async function expectRefused(
  run: () => Promise<unknown>, sqlstate: string, constraint: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    // drizzle wraps the server error; the SQLSTATE lives on the cause.
    const cause = (error as { cause?: unknown })?.cause ?? error;
    const code = (cause as { code?: unknown })?.code;
    const message = (cause as { message?: unknown })?.message;
    expect(code).toBe(sqlstate);
    expect(String(message)).toContain(constraint);
    return;
  }
  throw new Error(`expected the statement to be refused by ${constraint}`);
}

describe('scheduler schema', () => {
  test('organizations carry an IANA timezone and a quiet-hours window', async () => {
    const [row] = await getDb().select().from(schema.organizations)
      .where(sql`id = ${ORG}`);
    expect(row!.timezone).toBe('UTC');
    expect(row!.quietHoursStart).toBe(23);
    expect(row!.quietHoursEnd).toBe(8);
  });

  test('(schedule_id, slot) is UNIQUE — that is the whole idempotency mechanism', async () => {
    const scheduleId = await seedSchedule();
    const slot = '2026-11-01T01:30';
    await insertRun(scheduleId, slot, Date.UTC(2026, 10, 1, 5, 30));
    await expectRefused(
      () => insertRun(scheduleId, slot, Date.UTC(2026, 10, 1, 5, 30)),
      '23505', 'schedule_runs_schedule_slot_uq',
    );
    // The DST second pass is a DIFFERENT slot and must be accepted.
    await insertRun(scheduleId, `${slot}#2`, Date.UTC(2026, 10, 1, 6, 30));
    const runs = await getDb().select().from(schema.scheduleRuns)
      .where(sql`schedule_id = ${scheduleId}`);
    expect(runs.length).toBe(2);
  });

  test('schedule name is unique per organization', async () => {
    await seedSchedule('live-sync');
    await expectRefused(() => seedSchedule('live-sync'), '23505', 'schedules_org_name_uq');
  });

  test('every enum column is CHECK-constrained, not merely documented', async () => {
    const scheduleId = await seedSchedule();
    await expectRefused(
      () => getDb().execute(
        sql`update schedules set catchup_policy = 'run_everything' where id = ${scheduleId}`,
      ),
      '23514', 'catchup_policy_valid',
    );
    await expectRefused(
      () => getDb().execute(
        sql`update schedules set overlap_policy = 'whatever' where id = ${scheduleId}`,
      ),
      '23514', 'overlap_policy_valid',
    );
    await expectRefused(
      () => getDb().execute(
        sql`update schedules set kind = 'cron' where id = ${scheduleId}`,
      ),
      '23514', 'schedule_kind_valid',
    );
    await insertRun(scheduleId, 'bad-state-probe', Date.now());
    await expectRefused(
      () => getDb().execute(
        sql`update schedule_runs set state = 'kinda-running' where slot = 'bad-state-probe'`,
      ),
      '23514', 'run_state_valid',
    );
  });

  test('deleting a schedule cascades its runs but never its alerts history', async () => {
    const scheduleId = await seedSchedule();
    await insertRun(scheduleId, 'cascade-probe', Date.now());
    await getDb().insert(schema.scheduleAlerts).values({
      id: randomUUID(), organizationId: ORG, scheduleId, runId: null,
      kind: 'push_rejected', detail: { status: 'push_failed' },
    });
    await getDb().delete(schema.schedules).where(sql`id = ${scheduleId}`);

    const runs = await getDb().select().from(schema.scheduleRuns)
      .where(sql`schedule_id = ${scheduleId}`);
    expect(runs.length).toBe(0);

    const alerts = await getDb().select().from(schema.scheduleAlerts)
      .where(sql`organization_id = ${ORG} and kind = 'push_rejected'`);
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.scheduleId).toBeNull(); // set null, not deleted
  });

  async function seedSchedule(name = `job-${randomUUID().slice(0, 8)}`): Promise<string> {
    const id = randomUUID();
    await getDb().insert(schema.schedules).values({
      id, organizationId: ORG, connectionId: null, name,
      operation: 'sync', params: {}, kind: 'interval',
      intervalSeconds: 300, anchorAt: new Date(), createdBy: 'test',
    });
    return id;
  }

  async function insertRun(scheduleId: string, slot: string, fireAtMs: number): Promise<void> {
    await getDb().insert(schema.scheduleRuns).values({
      id: randomUUID(), scheduleId, organizationId: ORG, slot, fireAt: new Date(fireAtMs),
    });
  }
});
