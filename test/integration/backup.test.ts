import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import app from '../../src/control/app.ts';
import { BACKUP_HOST_ONLY_ERROR, runBackup } from '../../scripts/backup.ts';
import type { BackupManifest } from '../../scripts/backup.ts';
import { runMigrations, getDb, schema, closeDb, pinDb } from '../../src/control/db/client.ts';
import { bootstrapFirstAdmin } from '../../src/control/bootstrap.ts';
import { withStackExclusion } from '../helpers/stack.ts';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
// Host-side callOps (quiesce check) — container DNS name is unreachable here.
process.env.OPS_RPC_URL ??= 'http://127.0.0.1:3140';

const SKIP_BACKUP_INTEGRATION_ENV = 'BRAINSTAND_ALLOW_SKIP_BACKUP_INTEGRATION';

/**
 * Probed once at module load — ahead of every `test.skipIf` below.
 * Must finish in a few seconds: a 600s runBackup against a down stack is a hang
 * (Ruling 30), not a gate.
 */
async function probeBackupStack(): Promise<boolean> {
  const p = Bun.spawn(
    [
      'docker', 'compose',
      ...(existsSync('.env') ? ['--env-file', '.env'] : []),
      '-f', 'compose/docker-compose.yml',
      'ps', '--status', 'running', '-q', 'postgres', 'gbrain-ops',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const timer = setTimeout(() => p.kill(), 5_000);
  try {
    const [stdout, exitCode] = await Promise.all([
      new Response(p.stdout).text(),
      p.exited,
    ]);
    if (exitCode !== 0) return false;
    // One id per running service; need both postgres and gbrain-ops.
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    return ids.length >= 2;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const stackAvailable = await probeBackupStack();

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Run the real `scripts/backup.ts` in its OWN process.
 *
 * That script reads the supervisor status which becomes the manifest's
 * `quiesced`, and it reads it through `src/control/opsClient.ts` — a module six
 * sibling files in this directory mock, whose `mock.module` is process-wide:
 * bun applies a module mock to any module a later-linking file resolves, so in
 * THIS process the probe can be answered by a sibling's fake instead of ops.
 * Measured, with the fix reverted: the reply came back as
 * `{ok:true, exitCode:0, argv:["gbrain"], stdout:"{}"}` while `docker compose ps`
 * showed scheduler and gbrain-worker stopped — i.e. the manifest recorded
 * `quiesced:false` about a quiesced stack, and the shape named
 * agent-runs.test.ts's `ok({})` fake as the respondent. A fresh process has no
 * registered mocks, which is also how an operator runs this host script.
 */
async function runBackupInOwnProcess(outDir: string): Promise<void> {
  const program = 'import { runBackup } from '
    + JSON.stringify('./scripts/backup.ts') + ';\n'
    + `await runBackup(${JSON.stringify(outDir)});\n`;
  const proc = Bun.spawn(['bun', '-e', program], {
    cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `scripts/backup.ts exited ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }
}

// Pin at module load so a sibling file cannot close the pool before our beforeAll.
pinDb();

let out: string;
let cookie = '';
let emptyPathDir: string;

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'bs-backup-'));
  emptyPathDir = await mkdtemp(join(tmpdir(), 'bs-no-docker-'));
  // Empty dir on PATH so `docker` resolves to nothing (Ruling 31).
  await mkdir(emptyPathDir, { recursive: true });

  await runMigrations();
  for (const t of [
    schema.claimLinks, schema.connections, schema.spaces, schema.secrets, schema.auditLog,
    schema.sessions, schema.accounts, schema.verifications,
    schema.memberships, schema.brains, schema.organizations, schema.users,
  ]) {
    await getDb().delete(t);
  }
  await bootstrapFirstAdmin('backup-admin@example.test', 'a-long-enough-password', 'BackupOrg');

  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'backup-admin@example.test',
      password: 'a-long-enough-password',
    }),
  });
  cookie = res.headers.get('set-cookie') ?? '';
  expect(cookie).toBeTruthy();
}, 90_000);

afterAll(async () => {
  if (out) await rm(out, { recursive: true, force: true });
  if (emptyPathDir) await rm(emptyPathDir, { recursive: true, force: true });
  await closeDb();
});

describe('backup routes (no docker)', () => {
  test('GET /api/backup without auth is 401', async () => {
    const res = await app.request('/api/backup');
    expect(res.status).toBe(401);
  });

  // Ruling 2: backup must mount above the SPA catch-all.
  test('GET /api/backup is JSON, not the SPA index.html', async () => {
    const res = await app.request('/api/backup');
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toMatch(/application\/json/);
    const text = await res.text();
    expect(text).not.toMatch(/<!DOCTYPE html>/i);
    expect(text).not.toMatch(/<html/i);
  });

  // Ruling 31: control-plane without docker compose → 503 host-operation, not ENOENT 500.
  test('POST /api/backup returns 503 when docker compose is unavailable', async () => {
    const savedPath = process.env.PATH;
    const savedPathWin = process.env.Path;
    process.env.PATH = emptyPathDir;
    process.env.Path = emptyPathDir;
    try {
      const res = await app.request('/api/backup', {
        method: 'POST',
        headers: { cookie },
      });
      expect(res.status).toBe(503);
      const body = await res.json() as { error?: string };
      expect(body.error).toBe(BACKUP_HOST_ONLY_ERROR);
      expect(body.error).toMatch(/scripts\/backup\.ts/);
      expect(body.error).toMatch(/host/i);
    } finally {
      if (savedPath !== undefined) process.env.PATH = savedPath;
      else delete process.env.PATH;
      if (savedPathWin !== undefined) process.env.Path = savedPathWin;
      else delete process.env.Path;
    }
  }, 15_000);
});

describe('backup', () => {
  // Always runs — converts a silent skip into a loud one (Ruling 30).
  test('backup integration tests are not silently skipped', () => {
    if (stackAvailable) return;
    if (process.env[SKIP_BACKUP_INTEGRATION_ENV] === '1') return;

    throw new Error(
      'Could not reach the brainstand compose stack (postgres + gbrain-ops running), ' +
        'so the four-component backup integration tests were skipped rather than run. ' +
        'Bring the stack up, then rerun:\n\n' +
        '  bun run stack:up\n' +
        '  # or: docker compose --env-file .env -f compose/docker-compose.yml ' +
        '-f compose/docker-compose.dev.yml up -d --wait\n\n' +
        `If skipping is genuinely intended for this run, set ${SKIP_BACKUP_INTEGRATION_ENV}=1 ` +
        'to acknowledge it explicitly.',
    );
  });

  // gbrain's own backup DELIBERATELY excludes every credential, so a naive
  // restore yields intact knowledge and zero working agent connections (V9).
  // Our unit is four things versioned together.
  test.skipIf(!stackAvailable)('produces all four components plus a manifest', async () => {
    // Held for the whole run, not just its stop: `quiesced` comes from a status
    // read that only means anything if no other file restarts the worker in
    // between (withStackExclusion), and the run itself has to happen in a
    // process no sibling file has mocked (runBackupInOwnProcess).
    await withStackExclusion('backup.test.ts', () => runBackupInOwnProcess(out));
    const m: BackupManifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    const files = await readdir(out);
    expect(files).toContain('manifest.json');
    for (const f of Object.values(m.components)) expect(files).toContain(f);
    expect(Object.keys(m.components).sort())
      .toEqual(['brainDb', 'brainRepos', 'controlDb', 'secrets']);
  }, 600_000);

  test.skipIf(!stackAvailable)('the manifest records the gbrain version and a checksum per component', async () => {
    const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    expect(m.gbrainVersion).toBeTruthy();
    for (const k of Object.keys(m.components)) expect(m.sha256[k]).toMatch(/^[0-9a-f]{64}$/);
  });

  // Three artifacts taken at three moments are three artifacts that disagree.
  // `quiesced` is now the three-state result of a real probe (D6), so this
  // asserts the exact state and the lane that proved it — not merely truthy.
  test.skipIf(!stackAvailable)('the manifest records a verified quiesce and the lane that proved it', async () => {
    const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    expect(m.quiesced).toBe('verified');
    expect(m.quiesceLane === 'http' || m.quiesceLane === 'relay').toBe(true);
    console.log(`MEASURED backup quiesce at ${m.gbrainVersion}: quiesced=${m.quiesced} quiesceLane=${m.quiesceLane}`);
  });

  // A probe that could not run did not succeed (D6). Because runBackup takes an
  // INJECTED caller, these cases are answered by the caller handed in, not by a
  // sibling file's process-wide `mock.module` — so they can run in-process while
  // the manifest-producing case above runs the real script in its own process
  // under the cross-process stack-exclusion lock in test/helpers/stack.ts.
  test.skipIf(!stackAvailable)('an injected caller that throws is refused, never recorded as verified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bs-backup-refuse-'));
    try {
      const throwing = {
        kind: 'relay' as const,
        auditTail: async () => [],
        supervisorStatus: async () => { throw new Error('ops unreachable: getaddrinfo ENOTFOUND gbrain-ops'); },
      };
      await withStackExclusion('backup.test.ts', async () => {
        await expect(runBackup(dir, { ops: throwing })).rejects
          .toThrow(/could not verify the stack is quiesced/);
      });
      expect(existsSync(join(dir, 'manifest.json'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);

  test.skipIf(!stackAvailable)('allowUnquiesced takes the backup and stamps quiesced:unverified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bs-backup-unverified-'));
    try {
      const throwing = {
        kind: 'relay' as const,
        auditTail: async () => [],
        supervisorStatus: async () => { throw new Error('ops unreachable: getaddrinfo ENOTFOUND gbrain-ops'); },
      };
      await withStackExclusion('backup.test.ts', async () => {
        await runBackup(dir, { ops: throwing, allowUnquiesced: true });
      });
      const m: BackupManifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
      expect(m.quiesced).toBe('unverified');
      expect(m.quiesceLane).toBeNull();
      expect(m.warning).toMatch(/unverified/i);
      console.log(`MEASURED backup quiesce (allowUnquiesced) at ${m.gbrainVersion}: quiesced=${m.quiesced} quiesceLane=${m.quiesceLane}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);

  test.skipIf(!stackAvailable)('the secrets component is the encrypted table, not decrypted values', async () => {
    const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    const dump = await readFile(join(out, m.components.secrets), 'utf8');
    expect(dump).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(dump).toContain('wrapped_dek');
  });

  test.skipIf(!stackAvailable)('the manifest warns that ENCRYPTION_KEY is held separately', async () => {
    const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    expect(m.warning).toMatch(/ENCRYPTION_KEY/);
  });
});
