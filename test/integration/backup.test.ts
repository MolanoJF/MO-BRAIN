import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, readdir, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import app from '../../src/control/app.ts';
import { runBackup, BACKUP_HOST_ONLY_ERROR } from '../../scripts/backup.ts';
import { runMigrations, getDb, schema, closeDb, pinDb } from '../../src/control/db/client.ts';
import { bootstrapFirstAdmin } from '../../src/control/bootstrap.ts';

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
      'docker', 'compose', '--project-directory', '.',
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
    schema.spaces, schema.secrets, schema.auditLog,
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
        '  # or: docker compose --project-directory . -f compose/docker-compose.yml ' +
        '-f compose/docker-compose.dev.yml --env-file .env up -d --wait\n\n' +
        `If skipping is genuinely intended for this run, set ${SKIP_BACKUP_INTEGRATION_ENV}=1 ` +
        'to acknowledge it explicitly.',
    );
  });

  // gbrain's own backup DELIBERATELY excludes every credential, so a naive
  // restore yields intact knowledge and zero working agent connections (V9).
  // Our unit is four things versioned together.
  test.skipIf(!stackAvailable)('produces all four components plus a manifest', async () => {
    const m = await runBackup(out);
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
  test.skipIf(!stackAvailable)('the manifest records that the worker was quiesced', async () => {
    const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    expect(m.quiesced).toBe(true);
  });

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
