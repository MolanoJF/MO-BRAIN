import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { SQL } from 'bun';
import { runMigrations } from '../../src/control/db/client.ts';

const CONTROL_DATABASE_URL =
  process.env.CONTROL_DATABASE_URL ?? 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

const SCRATCH_PG_CMD =
  'docker run -d --name bs-fp-pg -e POSTGRES_USER=gbrain -e POSTGRES_PASSWORD=ci-not-a-real-secret ' +
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
const SKIP_SCHEMA_INTEGRATION_ENV = 'BRAINSTAND_ALLOW_SKIP_SCHEMA_INTEGRATION';

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
});
