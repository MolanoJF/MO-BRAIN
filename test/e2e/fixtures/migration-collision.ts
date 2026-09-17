/**
 * Gate C's migration-collision fixture (D9). TEST-ONLY — it is never imported
 * from `src/`, and the gate asserts that mechanically (C2's folded-in C0).
 *
 * The real 0.50.0.0 -> 0.50.5.0 delta ships ZERO schema migrations (U10), so
 * the exit gate's "deliberately fail a migration" half has nothing of its own
 * to fail on. This fixture creates the conditions for UPSTREAM's own migration
 * 144 to fail, and does nothing else:
 *
 *   1. regress the brain's recorded schema version from 149 to 143, so
 *      upstream's own migrations 144-149 become genuinely pending;
 *   2. replace `open_loops` with an incompatible table of the same name
 *      (id TEXT PRIMARY KEY), so upstream v144's
 *      `CREATE TABLE IF NOT EXISTS open_loops (...)` is a no-op and its
 *      following `CREATE INDEX ... ON open_loops (source_id, ...)` fails with
 *      SQLSTATE 42703 inside upstream's own DDL.
 *
 * The failure is upstream's — we do not raise it, catch it, or inject it. The
 * rollback under test is the SHIPPED path. Applied through the test-only psql
 * lane (`docker compose … exec -T gbrain-ops psql "$GBRAIN_DATABASE_URL" …`),
 * never through the ops RPC: there is no allowlist entry for it, and there must
 * not be one (G3).
 */

export type SqlResult = { exitCode: number; stdout: string; stderr: string };
/** Runs one SQL statement through the test-only psql lane. */
export type RunSql = (sql: string) => Promise<SqlResult>;

/** C0's marker, grepped over `src/` and `scripts/`: present here (test/) only. */
export const FIXTURE_MARKERS = /open_loops|FROM config WHERE key = 'version'/;

export const PRISTINE_SCHEMA_VERSION = '149';
export const FIXTURE_SCHEMA_VERSION = '143';
export const COLLIDING_OBJECT = 'open_loops';

export const FIXTURE_SUMMARY =
  'FIXTURE: config.version 149 -> 143; open_loops replaced (id TEXT PRIMARY KEY)';

/** Upstream v144's own index statement, re-run here to observe 42703 directly
 *  on the test-only lane (the product must NOT relay gbrain's stderr, G3). */
export const COLLISION_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS open_loops_status_idx '
  + 'ON open_loops (source_id, status, last_activity_at DESC)';

/** The real v144 table, embedded so un-fixture restores the exact schema. */
const RESTORE_OPEN_LOOPS = `CREATE TABLE open_loops (
  id                 BIGSERIAL PRIMARY KEY,
  source_id          TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  dedup_key          TEXT NOT NULL,
  loop_type          TEXT NOT NULL CHECK (loop_type IN (
                       'commitment_owed_by_me','commitment_owed_to_me',
                       'unanswered_inbound','unanswered_outbound','decision_pending')),
  counterparty_slug  TEXT,
  counterparty_email TEXT,
  summary            TEXT NOT NULL,
  evidence           JSONB NOT NULL DEFAULT '[]'::jsonb,
  thread_id          TEXT,
  page_slug          TEXT,
  due_at             TIMESTAMPTZ,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped','stale')),
  detector           TEXT NOT NULL CHECK (detector IN ('deterministic_thread','llm_extract','manual')),
  confidence         REAL NOT NULL DEFAULT 1.0,
  fact_id            BIGINT,
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at          TIMESTAMPTZ,
  closed_by          TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT open_loops_dedup UNIQUE (source_id, dedup_key)
)`;

function guard(): void {
  if (process.env.BRAINSTAND_E2E !== '1') {
    throw new Error(
      'the migration-collision fixture is test-only and refuses to run unless BRAINSTAND_E2E=1',
    );
  }
}

async function must(runSql: RunSql, sql: string): Promise<SqlResult> {
  const r = await runSql(sql);
  if (r.exitCode !== 0) {
    throw new Error(`fixture statement failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r;
}

export async function recordedSchemaVersion(runSql: RunSql): Promise<string> {
  guard();
  const r = await must(runSql, "select value from config where key = 'version'");
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? '';
}

export async function columnsOf(runSql: RunSql, table: string): Promise<string[]> {
  guard();
  const r = await must(
    runSql,
    "select column_name from information_schema.columns "
    + `where table_name = '${table}' order by ordinal_position`,
  );
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

export type AppliedFixture = {
  summary: string;
  recordedSchemaVersionBefore: string;
  recordedSchemaVersionAfter: string;
  collidingObject: string;
  statements: string[];
};

export async function applyMigrationCollisionFixture(runSql: RunSql): Promise<AppliedFixture> {
  guard();
  const before = await recordedSchemaVersion(runSql);
  const statements = [
    'DROP TABLE IF EXISTS open_loops CASCADE',
    'CREATE TABLE open_loops (id TEXT PRIMARY KEY)',
    `UPDATE config SET value = '${FIXTURE_SCHEMA_VERSION}' WHERE key = 'version'`,
  ];
  for (const sql of statements) await must(runSql, sql);
  const after = await recordedSchemaVersion(runSql);
  return {
    summary: FIXTURE_SUMMARY,
    recordedSchemaVersionBefore: before,
    recordedSchemaVersionAfter: after,
    collidingObject: COLLIDING_OBJECT,
    statements,
  };
}

/** Upstream v144's CREATE INDEX against the incompatible table. Expected to
 *  FAIL with SQLSTATE 42703 — observed here, on the test-only lane. */
export async function probeCollisionIndex(runSql: RunSql): Promise<SqlResult> {
  guard();
  return runSql(COLLISION_INDEX_SQL);
}

export type UndoneFixture = { summary: string; recordedSchemaVersionAfter: string };

export async function undoMigrationCollisionFixture(runSql: RunSql): Promise<UndoneFixture> {
  guard();
  const statements = [
    'DROP TABLE IF EXISTS open_loops CASCADE',
    RESTORE_OPEN_LOOPS,
    'CREATE INDEX IF NOT EXISTS open_loops_status_idx '
      + 'ON open_loops (source_id, status, last_activity_at DESC)',
    "CREATE INDEX IF NOT EXISTS open_loops_counterparty_idx "
      + "ON open_loops (source_id, counterparty_slug) WHERE status = 'open'",
    "CREATE INDEX IF NOT EXISTS open_loops_thread_idx "
      + "ON open_loops (source_id, thread_id) WHERE status = 'open'",
    `UPDATE config SET value = '${PRISTINE_SCHEMA_VERSION}' WHERE key = 'version'`,
  ];
  for (const sql of statements) await must(runSql, sql);
  const after = await recordedSchemaVersion(runSql);
  return {
    summary: `UN-FIXTURE: open_loops restored to the real schema; config.version -> ${after}`,
    recordedSchemaVersionAfter: after,
  };
}
