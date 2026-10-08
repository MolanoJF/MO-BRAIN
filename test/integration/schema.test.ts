import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SQL } from 'bun';
import { runMigrations } from '../../src/control/db/client.ts';

const CONTROL_DATABASE_URL =
  process.env.CONTROL_DATABASE_URL ?? 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

const SCRATCH_PG_CMD =
  'docker run -d --name mobrain-fp-pg -e POSTGRES_USER=gbrain -e POSTGRES_PASSWORD=ci-not-a-real-secret ' +
  '-e POSTGRES_DB=control -p 5432:5432 pgvector/pgvector:pg16';

/**
 * Probed once at module load — ahead of every `test.skipIf` below, since
 * skipIf needs its condition at test-registration time. Same shape as
 * fileplane.test.ts; a short connectionTimeout keeps a down Postgres from
 * stalling the whole file's registration.
 */
async function probePostgres(): Promise<boolean> {
  const probe = new SQL(CONTROL_DATABASE_URL, { connectionTimeout: 3, max: 1 });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
}

const postgresAvailable = await probePostgres();
const SKIP_SCHEMA_INTEGRATION_ENV = 'MOBRAIN_ALLOW_SKIP_SCHEMA_INTEGRATION';

const { pinDb } = await import('../../src/control/db/client.ts');
if (postgresAvailable) pinDb();

let sql: SQL;
beforeAll(async () => {
  if (!postgresAvailable) return;
  sql = new SQL(CONTROL_DATABASE_URL);
  await runMigrations();
}, 60_000);
afterAll(async () => {
  if (sql) await sql.end();
  const { closeDb } = await import('../../src/control/db/client.ts');
  await closeDb();
});

const cols = async (table: string) =>
  (await sql`select column_name from information_schema.columns where table_name = ${table}`)
    .map((r: any) => r.column_name).sort();

/**
 * Same trap scheduler-schema.test.ts documents (and the lifecycle probe above
 * hits): `expect(...).rejects` hangs on a bun SQL thenable, so a refusal is
 * asserted by SQLSTATE and by the constraint that fired — never by "it threw".
 *
 * Bun throws a PostgresError carrying `errno` and the constraint name; drizzle
 * wraps the same error one level down in `cause`, and auth.test.ts's `pgCode`
 * reads both. Reading both here keeps a refusal from passing for the wrong
 * reason (e.g. an FK miss instead of the CHECK under test).
 */
function pgRefusal(e: unknown): { errno?: string; text: string } {
  const phrases: string[] = [];
  let node: unknown = e;
  for (let depth = 0; depth < 3 && node && typeof node === 'object'; depth += 1) {
    const record = node as Record<string, unknown>; // narrow, read-only field access
    for (const key of ['errno', 'code', 'message']) {
      if (typeof record[key] === 'string') phrases.push(record[key]);
    }
    node = record.cause;
  }
  return { errno: phrases.find((p) => /^\d{5}$/.test(p)), text: phrases.join(' ') };
}

async function expectRefused(
  run: () => Promise<unknown>, sqlstate: string, constraint: string,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeDefined();
  const { errno, text } = pgRefusal(caught);
  expect(errno).toBe(sqlstate);
  expect(text).toContain(constraint);
}

/** Slice 4 fixtures. Fixed ids plus an idempotent cascade wipe, so a re-run of
 * this file cannot fail on a leftover row: deleting the org takes schedules,
 * schedule_runs and (Slice 4) agent_runs with it. */
const AGENT_ORG = 'o-agent';

async function seedOrg(): Promise<void> {
  await sql`delete from organizations where id = ${AGENT_ORG}`;
  await sql`insert into organizations (id, name, slug)
    values (${AGENT_ORG}, 'Agent', 'agent-slice4')`;
}

/** A valid gbrain_command schedule: operation set, no agent columns. */
async function seedSchedule(tag = 'plain'): Promise<string> {
  await seedOrg();
  const id = `sch-agent-${tag}`;
  await sql`insert into schedules
    (id, organization_id, name, operation, kind, interval_seconds, anchor_at, created_by)
    values (${id}, ${AGENT_ORG}, ${`name-${tag}`}, 'sync', 'interval', 300, now(), 'test')`;
  return id;
}

/** A schedule_run, which is `agent_runs`'s parent (PK runId -> schedule_runs.id). */
async function seedRun(tag = 'one'): Promise<string> {
  const scheduleId = await seedSchedule(tag);
  const runId = `sr-agent-${tag}`;
  await sql`insert into schedule_runs (id, schedule_id, organization_id, slot, fire_at)
    values (${runId}, ${scheduleId}, ${AGENT_ORG}, ${`agent-${tag}`}, now())`;
  return runId;
}

async function insertEvent(runId: string, seq: number): Promise<void> {
  // A fresh id every time: the (run_id, seq) UNIQUE index must be the thing that
  // refuses a replay, never the primary key of a reused id.
  await sql`insert into agent_run_events (id, run_id, seq, kind, data)
    values (${randomUUID()}, ${runId}, ${seq}, 'tool_use', ${JSON.stringify({ tool: 'put_page' })}::jsonb)`;
}

/** No cost_usd on purpose: an unpriced call is NULL, never 0. */
async function insertUsage(runId: string, seq: number): Promise<void> {
  await sql`insert into agent_run_usage
    (id, run_id, seq, model, input_tokens, output_tokens, cache_read_tokens,
     cache_write_tokens, stop_reason, http_status)
    values (${randomUUID()}, ${runId}, ${seq}, 'claude-haiku',
      12, 4, 0, 0, 'end_turn', 200)`;
}

describe('control schema', () => {
  // Always runs — converts a silent skip into a loud one. Task 15 Step 4
  // runs `bun test test/integration`; opaque Connection closed failures are
  // not a gate.
  test('schema integration tests are not silently skipped', () => {
    if (postgresAvailable) return;
    if (process.env[SKIP_SCHEMA_INTEGRATION_ENV] === '1') return;

    throw new Error(
      `Could not reach Postgres at ${CONTROL_DATABASE_URL}, so the control-schema integration tests ` +
        '(table presence, brain_mode, lifecycle CHECK, secrets ciphertext columns, Space=source unique) ' +
        'were skipped rather than run. Start the scratch Postgres from Task 3 Step 7:\n\n' +
        `  ${SCRATCH_PG_CMD}\n\nThen rerun. If skipping is genuinely intended for ` +
        `this run (e.g. a Postgres-less CI runner), set ${SKIP_SCHEMA_INTEGRATION_ENV}=1 to ` +
        'acknowledge it explicitly.',
    );
  });

  test.skipIf(!postgresAvailable).each([
    'organizations', 'memberships', 'brains', 'spaces', 'secrets',
    'capability_snapshots', 'playbook_ledger', 'audit_log',
    'connections', 'claim_links',
    'upgrade_runs', 'upgrade_events', 'upgrade_checklist_items',
    // Slice 4 agent runner.
    'agent_runs', 'agent_run_events', 'agent_run_usage',
    // Slice 4 D2: the runner's own sighting record.
    'runner_presence',
  ])('%s exists', async (t) => {
    const [row] = await sql`select to_regclass(${'public.' + t}) as r`;
    expect(row.r).not.toBeNull();
  });

  // Personal and company are the same deployment with a flag.
  test.skipIf(!postgresAvailable)('organizations carries brain_mode', async () => {
    expect(await cols('organizations')).toContain('brain_mode');
  });

  test.skipIf(!postgresAvailable)('brains carries the lifecycle column', async () => {
    expect(await cols('brains')).toContain('lifecycle');
  });

  test.skipIf(!postgresAvailable)('the lifecycle check constraint rejects an unknown state', async () => {
    // Parent row first: without it, FK on organization_id rejects before the
    // CHECK ever runs, and this test would go green with no lifecycle constraint.
    // Idempotent cleanup so re-runs do not fail on organizations_pkey.
    await sql`delete from brains where id = 'b-bad'`;
    await sql`delete from organizations where id = 'o-life'`;
    await sql`
      insert into organizations (id, name, slug)
      values ('o-life', 'Life', 'life')
    `;
    // Bun SQL Query objects hang under expect(...).rejects; assert via try/catch
    // and require the lifecycle_valid CHECK (errno 23514), not an FK miss.
    let err: any;
    try {
      await sql`
        insert into brains (id, organization_id, gbrain_home, lifecycle)
        values ('b-bad', 'o-life', '/srv/gbrain-home', 'not-a-state')
      `;
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err.message)).toContain('lifecycle_valid');
    expect(err.errno).toBe('23514');
  });

  // S3b: a Postgres dump must not be a credential dump.
  test.skipIf(!postgresAvailable)('secrets stores ciphertext columns, never a plaintext one', async () => {
    const c = await cols('secrets');
    expect(c).toContain('wrapped_dek');
    expect(c).toContain('payload');
    expect(c).toContain('version');
    expect(c).not.toContain('plaintext');
    expect(c).not.toContain('value');
  });

  test.skipIf(!postgresAvailable)('spaces is unique on (organization_id, source_id) — Space = source', async () => {
    const [row] = await sql`
      select count(*)::int as n from pg_indexes
      where tablename = 'spaces' and indexdef ilike '%unique%source_id%'`;
    expect(row.n).toBeGreaterThan(0);
  });

  // Ruling 26: Better Auth 1.7.5 columns added in 0001 — dropping them is red.
  test.skipIf(!postgresAvailable)('Better Auth 1.7.5 columns exist on sessions/accounts/verifications', async () => {
    expect(await cols('sessions')).toContain('updated_at');
    expect(await cols('sessions')).toContain('active_organization_id');
    const accounts = await cols('accounts');
    expect(accounts).toContain('updated_at');
    expect(accounts).toContain('id_token');
    expect(accounts).toContain('access_token_expires_at');
    expect(accounts).toContain('refresh_token_expires_at');
    expect(accounts).toContain('scope');
    const verifications = await cols('verifications');
    expect(verifications).toContain('created_at');
    expect(verifications).toContain('updated_at');
  });

  // S4: Connection state is structural — pending|active|revoked only.
  test.skipIf(!postgresAvailable)('connection_state_valid CHECK rejects an unknown state', async () => {
    // Parents first so FK does not fire before CHECK (same pattern as lifecycle).
    await sql`delete from connections where id = 'c-bad'`;
    await sql`delete from spaces where id = 's-conn'`;
    await sql`delete from memberships where id = 'm-conn'`;
    await sql`delete from organizations where id = 'o-conn'`;
    await sql`delete from users where id = 'u-conn'`;
    await sql`
      insert into users (id, email, email_verified)
      values ('u-conn', 'conn@example.com', false)
    `;
    await sql`
      insert into organizations (id, name, slug)
      values ('o-conn', 'Conn', 'conn')
    `;
    await sql`
      insert into memberships (id, user_id, organization_id, role)
      values ('m-conn', 'u-conn', 'o-conn', 'member')
    `;
    await sql`
      insert into spaces (id, organization_id, source_id, name, kind)
      values ('s-conn', 'o-conn', 'src-conn', 'Conn Space', 'local-git')
    `;
    let err: any;
    try {
      await sql`
        insert into connections (
          id, organization_id, membership_id, write_space_id,
          harness, client_name, profile, token_ttl, state
        ) values (
          'c-bad', 'o-conn', 'm-conn', 's-conn',
          'claude-code', 'bs-uconnxxx-conn', 'default', 3600, 'not-a-state'
        )
      `;
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err.message)).toContain('connection_state_valid');
    expect(err.errno).toBe('23514');
  });

  // A3: claim_links stores hash only — the token itself is never stored.
  test.skipIf(!postgresAvailable)('claim_links has token_hash and no token column', async () => {
    const c = await cols('claim_links');
    expect(c).toContain('token_hash');
    expect(c).not.toContain('token');
  });

  test.skipIf(!postgresAvailable)('connections is unique on (organization_id, client_name)', async () => {
    const [row] = await sql`
      select count(*)::int as n from pg_indexes
      where tablename = 'connections' and indexname = 'connections_org_client_name_uq'`;
    expect(row.n).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Slice 4, Task 4 — job type, the agent tables, the classification vocabulary.
  // ---------------------------------------------------------------------------

  // D2: jobType is the PAYLOAD shape (argv vs prompt) and shape_matches_kind is
  // the TIMING shape. Both apply to every row; neither subsumes the other.
  test.skipIf(!postgresAvailable)('shape_matches_job_type refuses every malformed job-type shape', async () => {
    const scheduleId = await seedSchedule();

    // An agent_prompt row with an incomplete payload: the columns are required,
    // not merely conventional.
    await expectRefused(
      () => sql`update schedules set job_type = 'agent_prompt', operation = null,
        agent_prompt = 'pointer at skill: weekly-report' where id = ${scheduleId}`,
      '23514', 'shape_matches_job_type',
    );

    // A complete agent payload that still carries `operation`: one payload shape
    // per row, never both.
    await expectRefused(
      () => sql`update schedules set job_type = 'agent_prompt', agent_prompt = 'pointer',
        agent_model = 'claude-haiku', agent_max_tokens = 4096,
        agent_budget_usd = '1.50', agent_harness_version = '1.2.3' where id = ${scheduleId}`,
      '23514', 'shape_matches_job_type',
    );

    // A gbrain_command row may not carry an agent column — the refusal runs the
    // other way too.
    await expectRefused(
      () => sql`update schedules set agent_prompt = 'pointer' where id = ${scheduleId}`,
      '23514', 'shape_matches_job_type',
    );

    await expectRefused(
      () => sql`update schedules set job_type = 'gpt_prompt' where id = ${scheduleId}`,
      '23514', 'job_type_valid',
    );

    // The accepted shape, asserted as a real row rather than a non-throw: an
    // agent_prompt schedule has no operation and all five agent columns.
    await sql`update schedules set job_type = 'agent_prompt', operation = null,
      agent_prompt = 'pointer at skill: weekly-report', agent_model = 'claude-haiku',
      agent_max_tokens = 4096, agent_budget_usd = '1.50', agent_harness_version = '1.2.3'
      where id = ${scheduleId}`;
    const [row] = await sql`select job_type, operation, agent_max_tokens, agent_budget_usd
      from schedules where id = ${scheduleId}`;
    expect(row.job_type).toBe('agent_prompt');
    expect(row.operation).toBeNull();
    expect(row.agent_max_tokens).toBe(4096);
    expect(row.agent_budget_usd).toBe('1.50');
  });

  // D11: the agent-run classes are appended to the ONE classification column,
  // and the pre-existing vocabulary is not silently widened to anything else.
  test.skipIf(!postgresAvailable)('run_classification_valid gains the three agent-run classes and keeps its fence', async () => {
    const runId = await seedRun();
    for (const c of ['budget_exceeded', 'agent_failed', 'infra_failed']) {
      await sql`update schedule_runs set classification = ${c} where id = ${runId}`;
      const [row] = await sql`select classification from schedule_runs where id = ${runId}`;
      expect(row.classification).toBe(c);
    }
    await expectRefused(
      () => sql`update schedule_runs set classification = 'agent_confused' where id = ${runId}`,
      '23514', 'run_classification_valid',
    );
  });

  // D2 copy of the upgrade_events reconciler shape: a retried events/usage write
  // re-upserts instead of duplicating, and a deleted run takes its child rows.
  test.skipIf(!postgresAvailable)('(run_id, seq) is UNIQUE on both agent child tables and cascades from schedule_runs', async () => {
    const runId = await seedRun();
    await sql`insert into agent_runs (run_id, organization_id, model, harness_version, budget_usd)
      values (${runId}, ${AGENT_ORG}, 'claude-haiku', '1.2.3', '5.00')`;
    await insertUsage(runId, 1);
    await expectRefused(() => insertUsage(runId, 1), '23505', 'agent_run_usage_run_seq_uq');
    await insertEvent(runId, 1);
    await expectRefused(() => insertEvent(runId, 1), '23505', 'agent_run_events_run_seq_uq');
    await insertEvent(runId, 2);

    // An unpriced model is NULL, never 0 (honesty rule 3) — and the rollup stays
    // a numeric sum of usages.
    const [sum] = await sql`select count(*)::int as n, sum(cost_usd::numeric) as total
      from agent_run_usage where run_id = ${runId}`;
    expect(sum.n).toBe(1);
    expect(sum.total).toBeNull();

    await sql`delete from schedule_runs where id = ${runId}`;
    const [after] = await sql`select
      (select count(*)::int from agent_runs where run_id = ${runId}) as runs,
      (select count(*)::int from agent_run_events where run_id = ${runId}) as events,
      (select count(*)::int from agent_run_usage where run_id = ${runId}) as usage`;
    expect(after.runs).toBe(0);
    expect(after.events).toBe(0);
    expect(after.usage).toBe(0);
  });

  // D2: the sighting record is one row per RUNNER, so the runner id is the key —
  // that is what makes the claim route's write an upsert rather than a growing
  // log of "a runner was here" rows (which would also be uncountable evidence in
  // the rollback digest).
  test.skipIf(!postgresAvailable)('runner_presence is keyed by the runner id, and a re-sighting is not a second row', async () => {
    const runnerId = 'schema-probe-0001';
    await sql`delete from runner_presence where runner_id = ${runnerId}`;
    await sql`insert into runner_presence (runner_id, harness_version)
      values (${runnerId}, '2.1.274')`;
    await expectRefused(
      () => sql`insert into runner_presence (runner_id, harness_version)
        values (${runnerId}, '2.1.275')`,
      '23505', 'runner_presence_pkey',
    );
    const [row] = await sql`select count(*)::int as n,
      max(harness_version) as version from runner_presence where runner_id = ${runnerId}`;
    expect(row.n).toBe(1);
    expect(row.version).toBe('2.1.274');
    await sql`delete from runner_presence where runner_id = ${runnerId}`;
  });
});
