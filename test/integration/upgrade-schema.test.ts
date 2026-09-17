import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, pinDb, runMigrations, schema } from '../../src/control/db/client.ts';

process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
pinDb();

/** Same trap test/integration/scheduler-schema.test.ts documents: `expect(...).rejects`
 * hangs on a drizzle PgRaw thenable under this bun. Pin refusals to SQLSTATE + constraint. */
async function expectRefused(
  run: () => Promise<unknown>, sqlstate: string, constraint: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const cause = (error as { cause?: unknown })?.cause ?? error;
    const code = (cause as { code?: unknown })?.code;
    const message = (cause as { message?: unknown })?.message;
    expect(code).toBe(sqlstate);
    expect(String(message)).toContain(constraint);
    return;
  }
  throw new Error(`expected the statement to be refused by ${constraint}`);
}

beforeAll(async () => { await runMigrations(); }, 60_000);
afterAll(async () => { await closeDb(); });

async function seedRun(): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.upgradeRuns).values({
    id, fromVersion: '0.50.0.0', toVersion: '0.50.5.0', createdBy: 'test',
  });
  return id;
}

async function insertEvent(runId: string, seq: number, step: string): Promise<void> {
  await getDb().insert(schema.upgradeEvents).values({
    id: randomUUID(), runId, seq, step, message: `${step} started`,
  });
}

async function seedChecklistItem(runId: string, itemKey: string): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.upgradeChecklistItems).values({
    id, runId, gbrainVersion: '0.50.2.0', itemKey, prompt: 'Confirm before continuing',
  });
  return id;
}

describe('upgrade tables', () => {
  test('upgrade_runs, upgrade_events and upgrade_checklist_items exist', async () => {
    const rows = await getDb().execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name in
        ('upgrade_runs', 'upgrade_events', 'upgrade_checklist_items')
    `);
    const names = [...rows].map((r: any) => r.table_name).sort();
    expect(names).toEqual(['upgrade_checklist_items', 'upgrade_events', 'upgrade_runs']);
  });

  test('upgrade_run_state_valid rejects a state outside the transition vocabulary', async () => {
    const id = await seedRun();
    await expectRefused(
      () => getDb().execute(sql`update upgrade_runs set state = 'sideways' where id = ${id}`),
      '23514', 'upgrade_run_state_valid',
    );
  });

  test('every legal upgrade_runs state is accepted, in order', async () => {
    const id = await seedRun();
    const states = [
      'planned', 'preflight_ok', 'quiesced', 'snapshot_taken', 'swapped', 'migrated',
      'playbooks_applied', 'gated_ok', 'completed', 'failed',
      'rolling_back', 'rolled_back', 'rollback_failed',
    ];
    for (const state of states) {
      await getDb().execute(sql`update upgrade_runs set state = ${state} where id = ${id}`);
    }
    const [row] = await getDb().execute(sql`select state from upgrade_runs where id = ${id}`);
    expect((row as any).state).toBe('rollback_failed');
  });

  test('(run_id, seq) is UNIQUE on upgrade_events — the idempotent-replay key (D2)', async () => {
    const runId = await seedRun();
    await insertEvent(runId, 1, 'quiesce');
    await expectRefused(() => insertEvent(runId, 1, 'quiesce-retry'), '23505', 'upgrade_events_run_seq_uq');
    await insertEvent(runId, 2, 'snapshot');
    const rows = await getDb().execute(sql`select seq from upgrade_events where run_id = ${runId} order by seq`);
    expect([...rows].map((r: any) => r.seq)).toEqual([1, 2]);
  });

  test('upgrade_events.level rejects anything outside info|warn|error', async () => {
    const runId = await seedRun();
    await insertEvent(runId, 1, 'quiesce');
    await expectRefused(
      () => getDb().execute(sql`update upgrade_events set level = 'fatal' where run_id = ${runId}`),
      '23514', 'upgrade_event_level_valid',
    );
  });

  test('upgrade_checklist_items.state rejects anything outside pending|acknowledged|declined', async () => {
    const runId = await seedRun();
    const itemId = await seedChecklistItem(runId, 'confirm-oauth-scopes');
    await expectRefused(
      () => getDb().execute(sql`update upgrade_checklist_items set state = 'ignored' where id = ${itemId}`),
      '23514', 'upgrade_checklist_state_valid',
    );
  });

  test('upgrade_checklist_run_key_uq is UNIQUE on (run_id, item_key)', async () => {
    const runId = await seedRun();
    await seedChecklistItem(runId, 'confirm-oauth-scopes');
    await expectRefused(
      () => seedChecklistItem(runId, 'confirm-oauth-scopes'),
      '23505', 'upgrade_checklist_run_key_uq',
    );
  });

  test('deleting a run cascades its events and checklist items', async () => {
    const runId = await seedRun();
    await insertEvent(runId, 1, 'quiesce');
    await seedChecklistItem(runId, 'confirm-oauth-scopes');
    await getDb().delete(schema.upgradeRuns).where(sql`id = ${runId}`);
    const events = await getDb().execute(sql`select 1 from upgrade_events where run_id = ${runId}`);
    const items = await getDb().execute(sql`select 1 from upgrade_checklist_items where run_id = ${runId}`);
    expect([...events].length).toBe(0);
    expect([...items].length).toBe(0);
  });

  test('the declared-tables allowlists in auth.test.ts and schema.test.ts both name all three tables', async () => {
    const authSrc = await Bun.file('test/integration/auth.test.ts').text();
    const schemaSrc = await Bun.file('test/integration/schema.test.ts').text();
    for (const table of ['upgrade_runs', 'upgrade_events', 'upgrade_checklist_items']) {
      expect(authSrc).toContain(`'${table}'`);
      expect(schemaSrc).toContain(`'${table}'`);
    }
  });
});
