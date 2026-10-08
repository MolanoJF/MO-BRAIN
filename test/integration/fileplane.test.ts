import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { SQL } from 'bun';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTROL_DATABASE_URL =
  process.env.CONTROL_DATABASE_URL ?? 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

const SCRATCH_PG_CMD =
  'docker run -d --name mobrain-fp-pg -e POSTGRES_USER=gbrain -e POSTGRES_PASSWORD=ci-not-a-real-secret ' +
  '-e POSTGRES_DB=control -p 5432:5432 pgvector/pgvector:pg16';

/**
 * Probed once at module load — ahead of every `test.skipIf` below, since
 * skipIf needs its condition at test-registration time, not inside a
 * `beforeAll` that runs later. Same shape as routing.test.ts's
 * `dockerAvailable`, just async because reachability needs a real connection
 * attempt rather than a PATH lookup. A short `connectionTimeout` keeps a
 * down Postgres from stalling the whole file's registration.
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
const posix = process.platform !== 'win32';

const SKIP_FILEPLANE_INTEGRATION_ENV = 'MOBRAIN_ALLOW_SKIP_FILEPLANE_INTEGRATION';

let dir: string;
let sql: SQL;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bs-fp-'));
  process.env.GBRAIN_HOME = dir;
  sql = new SQL(CONTROL_DATABASE_URL);
});
afterAll(async () => {
  if (sql) await sql.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('file-plane writer against a real Postgres control DB', () => {
  // Always runs, unconditionally — converts a silent skip into a loud one.
  // Task 15 Step 4 runs `bun test test/integration` as a final gate; without
  // this, an unreachable Postgres would make every test below vanish via
  // `skipIf` with no signal beyond a handful of bare "Connection closed"
  // errors, leaving the next person to guess they need the Step 7 container.
  test('fileplane integration tests are not silently skipped', () => {
    if (postgresAvailable) return; // the real tests below actually ran
    if (process.env[SKIP_FILEPLANE_INTEGRATION_ENV] === '1') return; // explicit human opt-out

    throw new Error(
      `Could not reach Postgres at ${CONTROL_DATABASE_URL}, so the file-plane integration tests ` +
        '(advisory-lock mutual exclusion, atomic writes, corrupt-document refusal, schema-pack ' +
        'path-traversal rejection) were skipped rather than run. Start the scratch Postgres from ' +
        `Task 3 Step 7:\n\n  ${SCRATCH_PG_CMD}\n\nThen rerun. If skipping is genuinely intended for ` +
        `this run (e.g. a Postgres-less CI runner), set ${SKIP_FILEPLANE_INTEGRATION_ENV}=1 to ` +
        'acknowledge it explicitly.',
    );
  });

  // This is the one property S3 exists to provide, proved directly rather
  // than inferred from a correct outcome: contend for the SAME key from
  // several concurrent callers, have each record when it enters and leaves
  // the critical section, and assert the "currently inside" count never
  // exceeds 1. No mocks — real Postgres, real Promise.all. A lock that did
  // nothing would let all callers' `active += 1` run before any
  // `active -= 1` (they all hang on the same Bun.sleep), so this test fails
  // loudly against a no-op lock and only passes when mutual exclusion is
  // real (see task-3-report.md for the side-by-side RED/GREEN run against a
  // deliberately neutered lock).
  test.skipIf(!postgresAvailable)(
    'withAdvisoryLock enforces mutual exclusion — concurrent callers never overlap',
    async () => {
      const { withAdvisoryLock } = await import('../../src/ops/lock.ts');

      const key = 'test:mutual-exclusion';
      let active = 0;
      let maxActive = 0;
      const order: string[] = [];

      const caller = (id: number) =>
        withAdvisoryLock(sql, key, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          order.push(`enter:${id}`);
          // Hold the critical section open long enough that, without real
          // mutual exclusion, the other concurrent callers would have time
          // to also enter while this one is still "inside".
          await Bun.sleep(75);
          order.push(`exit:${id}`);
          active -= 1;
        });

      await Promise.all([caller(1), caller(2), caller(3), caller(4)]);

      expect(maxActive).toBe(1);
      expect(active).toBe(0);
      // Each caller's own enter must be immediately followed by its own exit
      // before the next caller's enter appears anywhere in the interleaving.
      for (let i = 0; i < order.length; i += 2) {
        const id = order[i]!.split(':')[1];
        expect(order[i + 1]).toBe(`exit:${id}`);
      }
    },
  );

  test.skipIf(!postgresAvailable)('concurrent patches both survive — neither key is lost', async () => {
    const { patchConfig, CONFIG_PATH } = await import('../../src/ops/fileplane.ts');

    await Promise.all([
      patchConfig({ openai_api_key: 'sk-alpha' }, { sql }),
      patchConfig({ anthropic_api_key: 'sk-beta' }, { sql }),
    ]);

    const written = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    expect(written.openai_api_key).toBe('sk-alpha');
    expect(written.anthropic_api_key).toBe('sk-beta');
  });

  // The 0600 check below is skip-worthy on win32 for a CATEGORICAL reason,
  // not an anomalous one: NTFS has no POSIX owner/group/other permission
  // bits, so Node's fs.chmod/fs.stat cannot express or verify 0600 there —
  // a writable file always reports mode 0o666 on Windows regardless of what
  // was requested. No action by a developer on this platform can ever make
  // the assertion run for real, so (unlike the Postgres-reachability guard
  // above, which fails loudly because installing Docker DOES fix it) this
  // is a visible, non-failing skip: printed once so it's never silent, but
  // never red on a correctly-configured Windows machine. The assertion
  // itself is still fully real and still enforced — just on POSIX (Linux,
  // CI, containers), where the mode bits it checks actually exist.
  if (!posix) {
    console.log(
      '[fileplane.test.ts] Skipping "config.json is written 0600" on win32: NTFS has no POSIX ' +
        'permission bits, so this assertion cannot be expressed here. It runs for real on POSIX ' +
        '(Linux/CI) — see task-3-report.md for a confirmed-green run inside a Linux container.',
    );
  }

  test.skipIf(!postgresAvailable || !posix)('config.json is written 0600', async () => {
    const { CONFIG_PATH } = await import('../../src/ops/fileplane.ts');
    const { stat } = await import('node:fs/promises');
    const s = await stat(CONFIG_PATH);
    expect(s.mode & 0o777).toBe(0o600);
  });

  test.skipIf(!postgresAvailable)('a corrupt config.json is never clobbered', async () => {
    const { patchConfig, CONFIG_PATH } = await import('../../src/ops/fileplane.ts');
    await Bun.write(CONFIG_PATH, '{ truncated');
    await expect(patchConfig({ a: 1 }, { sql })).rejects.toThrow('refusing to overwrite');
    expect(await readFile(CONFIG_PATH, 'utf8')).toBe('{ truncated');
  });

  test.skipIf(!postgresAvailable)('a schema pack name with a path traversal is rejected', async () => {
    const { writeSchemaPack } = await import('../../src/ops/fileplane.ts');
    await expect(writeSchemaPack('../../etc/passwd', 'x: 1', { sql }))
      .rejects.toThrow('invalid schema pack name');
  });
});
