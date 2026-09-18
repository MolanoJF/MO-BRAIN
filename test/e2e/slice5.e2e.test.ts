import { test, expect, afterAll } from 'bun:test';
// Bind host OPS URL before opsClient (and backup/restore) evaluate — static
// imports are hoisted; this side-effect module must be first among our deps.
import './host-ops-env.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackup } from '../../scripts/backup.ts';
import { runRestore } from '../../scripts/restore.ts';

const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8443';
const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PASSWORD = 'a-long-enough-password';
const SKIP_SLICE5_E2E_ENV = 'MOBRAIN_ALLOW_SKIP_SLICE5_E2E';

const fetchInsecure = (path: string, init?: RequestInit) =>
  fetch(`${BASE}${path}`, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);

/**
 * Probed once at module load — ahead of every `test.skipIf` below. Must finish
 * in a few seconds: a multi-hour backup/restore e2e against a down docker
 * daemon is a hang (Ruling 30), not a gate.
 */
async function probeDockerCompose(): Promise<boolean> {
  try {
    return (await Bun.$`docker compose version`.quiet().nothrow()).exitCode === 0;
  } catch {
    return false;
  }
}

const dockerAvailable = await probeDockerCompose();

function harvestCookie(res: Response): string {
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') ?? ''];
  return setCookies.filter(Boolean).map((c) => c.split(';')[0]!).join('; ');
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetchInsecure('/api/auth/sign-in/email', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`sign-in ${email} -> ${res.status} ${await res.text()}`);
  const c = harvestCookie(res);
  if (!c) throw new Error(`sign-in ${email} returned no cookie`);
  return c;
}

type ConnectionRow = { id: string; state: string; clientName: string };

/** GET /api/connections — the exact surface the console's Connection page reads. */
async function listConnections(cookie: string): Promise<ConnectionRow[]> {
  const res = await fetchInsecure('/api/connections', { headers: { cookie } });
  if (res.status !== 200) {
    throw new Error(`GET /api/connections -> ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { connections: ConnectionRow[] }).connections;
}

/** C7's archive; C8 restores it. */
let backupDir = '';

afterAll(async () => {
  if (backupDir) await rm(backupDir, { recursive: true, force: true });
});

test('slice5 e2e tests are not silently skipped', () => {
  if (dockerAvailable) return;
  if (process.env[SKIP_SLICE5_E2E_ENV] === '1') return;
  throw new Error(
    'docker compose is not usable, so the slice5 e2e suite was skipped rather than run. ' +
      'Install/start Docker, then rerun:\n\n' +
      '  bun test --parallel=1 test/e2e/slice5.e2e.test.ts\n\n' +
      `If skipping is genuinely intended for this run, set ${SKIP_SLICE5_E2E_ENV}=1 ` +
      'to acknowledge it explicitly.',
  );
});

test('C1: /metrics does not answer an unauthenticated public request', async () => {
  const res = await fetch(`${BASE}/metrics`, { tls: { rejectUnauthorized: false } });
  console.log(`MEASURED public /metrics: ${res.status}`);
  expect([401, 403, 404]).toContain(res.status);
});

// C7 — a backup on the running stack proves its own quiesce. `quiesced` is the
// three-state honesty field (D6): on the dev stack the ops port is published,
// so the lane is `http`; on a production-shaped stack it is `relay`. Either
// way it must be verified and NAME the lane that proved it, never merely truthy.
test.skipIf(!dockerAvailable)('C7: a backup verifies its quiesce and names the lane', async () => {
  backupDir = await mkdtemp(join(tmpdir(), 'slice5-dr-'));
  const manifest = await runBackup(backupDir);
  console.log(
    `MEASURED C7 quiesced=${manifest.quiesced} quiesceLane=${manifest.quiesceLane} id=${manifest.id}`,
  );
  expect(manifest.quiesced).toBe('verified');
  expect(manifest.quiesceLane === 'http' || manifest.quiesceLane === 'relay').toBe(true);
}, 900_000);

// C8 — restore to a DIFFERENT domain. OAuth redirect URIs and issuer URLs are
// domain-bound, so every grant is invalidated. The console must say so rather
// than keep showing a working Connection that is not one: no Connection may
// remain `active` after the restore.
test.skipIf(!dockerAvailable)(
  'C8: restore to a new domain invalidates every Connection, and the console says so',
  async () => {
    if (!backupDir) throw new Error("C8 needs C7's archive; run the whole file");
    const cookieBefore = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const before = await listConnections(cookieBefore);
    const activeBefore = before.filter((c) => c.state === 'active');
    console.log(`MEASURED C8 before active=${activeBefore.length} total=${before.length}`);
    expect(activeBefore.length).toBeGreaterThan(0);

    const report = await runRestore(backupDir, { newDomain: 'drill-new-domain.example.test' });
    expect(report.domainChanged).toBe(true);

    // The control DB was reloaded from the archive, so the pre-restore session
    // is gone — sign in again to read the console the operator would see.
    const cookieAfter = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const after = await listConnections(cookieAfter);
    const stillActive = after.filter((c) => c.state === 'active');
    console.log(
      `MEASURED C8 domainChanged=${report.domainChanged} `
        + `needingReissue=${report.connectionsNeedingReissue.length} `
        + `activeAfter=${stillActive.length} total=${after.length}`,
    );

    // "rather than showing a working Connection that is not": zero active.
    expect(stillActive.map((c) => c.clientName)).toEqual([]);
  },
  1_800_000,
);
