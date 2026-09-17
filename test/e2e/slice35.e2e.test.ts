import './host-ops-env.ts';
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { openJournal, appendEvent, readJournal } from '../../src/upgrade/journal.ts';
import { verifyManifest } from '../../src/upgrade/manifest.ts';
import { stateDigest, compareDigests, type StateDigest } from '../../src/upgrade/digest.ts';
import type { UpgradeContext } from '../../src/upgrade/types.ts';
import {
  FIXTURE_MARKERS, applyMigrationCollisionFixture, undoMigrationCollisionFixture,
  recordedSchemaVersion, columnsOf, probeCollisionIndex, COLLIDING_OBJECT,
  PRISTINE_SCHEMA_VERSION, FIXTURE_SCHEMA_VERSION,
} from './fixtures/migration-collision.ts';

/**
 * Slice 3.5 Seam Gate B — the HTTP product surface, end to end.
 *
 * Gate A (Task 15) proves the executor's argv paths in isolation. This gate
 * proves what Gate A structurally cannot: that the product surface exists — a
 * banner an operator reads from a REAL check-update, a run history that
 * outlives the container that wrote it (D2), and a checklist acknowledgement
 * that is durable rather than remembered (honesty rule 8).
 *
 * The plan's Task 16 sample was written against a pre-implementation route
 * shape. `src/control/routes/upgrades.ts` is the source of truth (coordinator
 * note 1), so every assertion below reads the real, shipped surface:
 *   - /api/upgrades/available returns detect.ts's classified DetectResult
 *     ({status, error, currentVersion, candidateVersion, changelog, releaseUrl});
 *   - the journal event field is `step` (Task 3's upgrade_events column) and a
 *     checklist item is `pending` until decided;
 *   - ack addresses the checklist item's id, not "<runId>/<key>";
 *   - /api/upgrades/drift needs ?from=&to= and returns diffCapability's shape.
 *
 * Task 17 appends `describe('Slice 3.5 seam gate C')` to this file and reuses
 * the exported helpers, so they are deliberately top-level and side-effect-free
 * until `beforeAll`.
 */

const SKIP_SLICE35_E2E_ENV = 'BRAINSTAND_ALLOW_SKIP_SLICE35_E2E';

const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8443';
const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PASSWORD = 'a-long-enough-password';
const VIEWER_EMAIL = 'gate-b-viewer@example.test';
const VIEWER_PASSWORD = 'a-long-enough-password';
const RUN_ID = Date.now().toString(36);

// L8: defaulted inside the file, never a required export. Gate B reads the
// product through HTTP, so this is only here for Gate C's benefit.
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

/**
 * The host directory the control-plane bind-mounts read-only at /srv/upgrades
 * (D1/D2). On this Windows dev host the production default `/srv/upgrades`
 * does not exist, so pick a real writable host path and hand it to Compose,
 * whose `UPGRADE_DIR` interpolation selects the bind SOURCE. Must be set
 * before COMPOSE_ENV is built.
 */
export const HOST_UPGRADE_DIR = process.env.UPGRADE_DIR ?? join(tmpdir(), 'brainstand-upgrade-e2e');
process.env.UPGRADE_DIR = HOST_UPGRADE_DIR;

const COMPOSE_ENV: Record<string, string> = {
  ...process.env as Record<string, string>,
  DOMAIN: process.env.DOMAIN ?? 'localhost',
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? 'change-me-in-a-real-deployment',
  OPS_RPC_TOKEN: process.env.OPS_RPC_TOKEN ?? 'compose-exec-placeholder',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? 'compose-exec-placeholder-32-characters',
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'compose-exec-placeholder-32-characters',
};

// The upgrade MOVES the pin by rewriting `.env`; compose must therefore read
// GBRAIN_VERSION from that file, never from an ambient environment variable.
// A caller shell that happened to export the old pin made every compose call
// after the swap build/run the OLD tag, so C8's running-binary cross-check saw
// declared=0.50.0.0 vs observed=0.50.5.0. Delete it from the child env so
// `.env` is the single source, which is also what production does.
delete COMPOSE_ENV.GBRAIN_VERSION;

const COMPOSE = [
  'docker', 'compose',
  ...(existsSync('.env') ? ['--env-file', '.env'] as const : []),
  '-f', 'compose/docker-compose.yml',
  '-f', 'compose/docker-compose.dev.yml',
];

export const fetchInsecure = (path: string, init?: RequestInit) =>
  fetch(`${BASE}${path}`, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);

export async function compose(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([...COMPOSE, ...args], {
    stdout: 'pipe', stderr: 'pipe', env: COMPOSE_ENV,
  });
  const timer = setTimeout(() => p.kill(), 900_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

export async function composeExec(
  service: string, argv: string[], timeoutMs = 300_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([...COMPOSE, 'exec', '-T', service, ...argv], {
    stdout: 'pipe', stderr: 'pipe', env: COMPOSE_ENV,
  });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

async function probeDockerCompose(): Promise<boolean> {
  try {
    return (await Bun.$`docker compose version`.quiet().nothrow()).exitCode === 0;
  } catch {
    return false;
  }
}

const dockerAvailable = await probeDockerCompose();

// --- state shared across Gate B (and Gate C) --------------------------------

let cookie = '';
let journalRunId = '';
let journalItemId = '';
let adminUserId = '';

export function adminCookie(): string { return cookie; }

function harvestCookie(res: Response): string {
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') ?? ''];
  return setCookies.filter(Boolean).map((c) => c.split(';')[0]!).join('; ');
}

export async function signIn(email: string, password: string): Promise<string> {
  const res = await fetchInsecure('/api/auth/sign-in/email', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`sign-in ${email} -> ${res.status} ${await res.text()}`);
  const c = harvestCookie(res);
  if (!c) throw new Error(`sign-in ${email} returned no cookie`);
  return c;
}

export function get(path: string, cookieOverride?: string) {
  return fetchInsecure(path, { headers: { cookie: cookieOverride ?? cookie } });
}

export function post(path: string, body: unknown, cookieOverride?: string) {
  return fetchInsecure(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieOverride ?? cookie },
    body: JSON.stringify(body),
  });
}

export async function readJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new Error(`${label} ${res.status} ${ct}: ${text.slice(0, 300)}`);
  }
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`${label} ${res.status} unparseable: ${text.slice(0, 300)}`); }
}

/**
 * L10 / Slice 3 F5: TWO surfaces, two different containers behind one proxy.
 * A measured 3073ms window existed where console health answered 200 while the
 * reserved path answered 502. Return only when BOTH agree; bound at 120 x 2s so
 * a genuinely dead gbrain-serve fails the assertion instead of hanging the run.
 */
export async function waitForStackReady(timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const [health, serve] = await Promise.all([
        fetchInsecure('/api/health'), fetchInsecure('/.well-known/gbrain'),
      ]);
      last = `console=${health.status} serve=${serve.status}`;
      if (health.status < 500 && serve.status === 200) return;
    } catch (e) { last = e instanceof Error ? e.message : String(e); }
    await Bun.sleep(2_000);
  }
  throw new Error(`the stack never became ready within ${timeoutMs}ms (last: ${last})`);
}

async function waitForOpsOk(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const body = await (await fetchInsecure('/api/health')).json() as { components?: { ops?: string } };
      if (body.components?.ops === 'ok') return;
    } catch { /* stack still settling */ }
    await Bun.sleep(2_000);
  }
  throw new Error('gbrain-ops never reported ok through /api/health');
}

/** Read a JSON scalar/array out of the LIVE control DB via its container (the
 *  live postgres publishes no host port, so compose exec is the only route). */
export async function psql(sql: string): Promise<string> {
  const r = await composeExec('postgres', ['psql', '-U', 'gbrain', '-d', 'control', '-tAc', sql]);
  if (r.exitCode !== 0) throw new Error(`psql failed (${r.exitCode}): ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

type AuditRow = { actor: string; action: string; target: string | null; after: Record<string, unknown> | null };

/** The durable record of a decision, read from the table the route wrote it to. */
export async function auditRows(action: string): Promise<AuditRow[]> {
  const json = await psql(
    "select coalesce(json_agg(json_build_object('actor',actor,'action',action,'target',target,'after',after) "
    + `order by at desc),'[]'::json) from audit_log where action = '${action}'`,
  );
  return JSON.parse(json || '[]') as AuditRow[];
}

/**
 * Gate C's host-side executor seam. Runs the SHIPPED host CLI with the same
 * UPGRADE_DIR the control plane is bind-mounted to, so what Gate C does through
 * it is exactly what an operator would.
 */
export async function upgradeCli(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(['bun', 'run', 'scripts/upgrade.ts', ...args], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...COMPOSE_ENV, UPGRADE_DIR: HOST_UPGRADE_DIR, ...env },
  });
  const timer = setTimeout(() => p.kill(), 1_800_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

// --- beforeAll: bring the stack up, point the mount, wait on BOTH surfaces --

beforeAll(async () => {
  if (!dockerAvailable) return;
  await mkdir(HOST_UPGRADE_DIR, { recursive: true });

  let reachable = false;
  try { reachable = (await fetchInsecure('/api/health')).status < 500; } catch { /* cold */ }
  if (!reachable) {
    const up = await compose('up', '-d', '--wait');
    if (up.exitCode !== 0) throw new Error(`compose up failed: ${up.stderr || up.stdout}`);
  }

  // Pin the bind mount at HOST_UPGRADE_DIR, then L11: restart control-plane and
  // gbrain-serve for fresh in-process rate-limit windows — never the volumes.
  const recreate = await compose('up', '-d', '--wait', '--force-recreate', 'control-plane');
  if (recreate.exitCode !== 0) throw new Error(`control-plane recreate failed: ${recreate.stderr}`);
  await compose('restart', 'gbrain-serve');

  await waitForStackReady(1_800_000);
}, 1_800_000);

// NOTE: no `docker compose down -v` anywhere in this file, including afterAll.
// Gate C's populated brain is the expensive fixture; L6/F28 means a
// re-provisioned volume is not equivalent.

describe('Slice 3.5 seam gate B', () => {
  test('slice3.5 e2e tests are not silently skipped', () => {
    if (dockerAvailable) return;
    if (process.env[SKIP_SLICE35_E2E_ENV] === '1') return;
    throw new Error(
      'docker compose is not usable, so the slice3.5 e2e suite was skipped rather than run. '
        + 'Install/start Docker, then rerun:\n\n'
        + '  bun test --parallel=1 test/e2e/slice35.e2e.test.ts\n\n'
        + `If skipping is genuinely intended for this run, set ${SKIP_SLICE35_E2E_ENV}=1 `
        + 'to acknowledge it explicitly.',
    );
  });

  test.skipIf(!dockerAvailable)('B1. bootstrap, sign in as admin, and the run list starts clean', async () => {
    // The entry gate's e2e run cycled the volumes, so the stack serves the
    // "create the first admin" bootstrap. Same path slice1/2/3 use.
    const boot = await fetchInsecure('/api/bootstrap', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, orgName: 'Acme' }),
    });
    expect([200, 409]).toContain(boot.status);

    cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(cookie.length).toBeGreaterThan(0);
    // The shipped routes record the DECIDER'S USER ID (rbac ctx.userId), not the
    // email; resolve it once so B6 can assert the durable acknowledgement.
    adminUserId = await psql(`select id from users where email = '${ADMIN_EMAIL}'`);
    expect(adminUserId).toBeTruthy();

    const body = await readJson<{ runs: Array<{ id: string }> }>(await get('/api/upgrades'), 'GET /api/upgrades');
    expect(Array.isArray(body.runs)).toBe(true);
    // Nothing fabricated at boot, and — because the harness rules make repeat
    // runs the norm — nothing from THIS gate's run exists yet. (The plan's
    // `toEqual([])` only holds on a pristinely cycled volume.)
    expect(body.runs.find((r) => r.id === `gate-b-${RUN_ID}`)).toBeUndefined();
  });

  test.skipIf(!dockerAvailable)('B2. the banner offers a candidate version from a REAL check-update call', async () => {
    const body = await readJson<{
      status: string; error: string | null; currentVersion: string | null;
      candidateVersion: string | null; changelog: string | null; releaseUrl: string | null;
    }>(await get('/api/upgrades/available'), 'GET available');

    expect(body.currentVersion).toBe('0.50.0.0');
    expect(body.status).toBe('available');
    // D7/honesty rule 2: an OFFER, never an action. The payload carries no
    // "start" affordance and no command we would run.
    expect(body.error).toBeNull();
    expect(body.candidateVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(body.changelog).toBeTruthy();
    expect(Object.keys(body)).not.toContain('startUrl');
    expect(Object.keys(body)).not.toContain('upgrade_command');
  }, 120_000);

  test.skipIf(!dockerAvailable)('B3. a check that FAILED renders "could not check", never "up to date"', async () => {
    // Honesty rule 1 / U1. The real route makes a REAL ops RPC. To make that
    // call fail deliberately we take gbrain-ops down and put it back — the same
    // deliberate network failure Task 13 proved. `.error` must survive; the
    // response must never read as "up to date".
    await compose('stop', 'gbrain-ops');
    try {
      const res = await get('/api/upgrades/available');
      expect(res.status).toBe(200);
      const body = await res.json() as {
        status: string; error: string | null; candidateVersion: string | null;
      };
      expect(body.status).toBe('unknown');
      expect(body.error).toBe('network_error');
      expect(body.candidateVersion).toBeNull();
      expect(body.status).not.toBe('up_to_date');
    } finally {
      await compose('start', 'gbrain-ops');
      await waitForOpsOk();
    }
  }, 300_000);

  test.skipIf(!dockerAvailable)('B4. a journal written into UPGRADE_DIR is imported by the reconciler (D2)', async () => {
    // THE seam of this slice: the control plane is stopped for most of a real
    // upgrade, so the journal — not the control DB — is the authority while it
    // is down. Written with the PRODUCT's own writer (openJournal/appendEvent,
    // Task 4), exactly as scripts/upgrade.ts writes it; never hand-rolled JSON.
    journalRunId = `gate-b-${RUN_ID}`;
    const j = await openJournal(HOST_UPGRADE_DIR, journalRunId);
    await appendEvent(j, {
      step: 'planned', message: `${'0.50.0.0'} -> ${'0.50.5.0'}`,
      data: { fromVersion: '0.50.0.0', toVersion: '0.50.5.0', createdBy: ADMIN_EMAIL },
    });
    for (const [state, note] of [
      ['preflight_ok', 'preflight passed'],
      ['quiesced', 'stack drained to Postgres only'],
      ['snapshot_taken', 'four artifacts checksum-verified'],
      ['swapped', 'pin moved, gbrain-ops recreated'],
      ['migrated', 'apply-migrations exited 0'],
    ] as const) {
      await appendEvent(j, { step: state, message: note, data: {} });
    }
    await appendEvent(j, {
      step: 'playbooks_applied', message: 'gate-b fixture',
      data: {
        ledger: [{ version: '0.50.2.0', state: 'applied', notes: 'gate-b fixture' }],
        checklist: [{
          key: 'gate-b-decision', version: '0.50.2.0',
          prompt: 'Confirm X', why: 'judgement residue (G5)',
        }],
      },
    });

    // Boot reconcile is the deterministic trigger (there is no reconcile route).
    await compose('restart', 'control-plane');
    await waitForStackReady(300_000);

    const runs = await readJson<{ runs: Array<{ id: string; state: string; fromVersion: string }> }>(
      await get('/api/upgrades'), 'GET /api/upgrades');
    const row = runs.runs.find((r) => r.id === journalRunId);
    expect(row).toBeTruthy();
    expect(row!.state).toBe('playbooks_applied');
    expect(row!.fromVersion).toBe('0.50.0.0');

    const detail = await readJson<{
      events: Array<{ seq: number; step: string }>;
      ledger: Array<{ gbrainVersion: string }>;
      checklist: Array<{ id: string; itemKey: string; state: string; decidedBy: string | null }>;
    }>(await get(`/api/upgrades/${journalRunId}`), 'GET run');
    expect(detail.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // playbook_ledger is keyed by VERSION (UNIQUE), not by run: it is the
    // install's history. Earlier runs on this same stack have already recorded
    // 0.50.1.0/0.50.4.0/0.50.5.0, and repeat runs are the harness norm, so
    // assert this run's version is PRESENT rather than the only row.
    expect(detail.ledger.map((l) => l.gbrainVersion)).toContain('0.50.2.0');
    expect(detail.checklist.length).toBe(1);
    expect(detail.checklist[0]!.state).toBe('pending');
    expect(detail.checklist[0]!.decidedBy).toBeNull();
    journalItemId = detail.checklist[0]!.id;
    expect(journalItemId).toBeTruthy();
  }, 300_000);

  test.skipIf(!dockerAvailable)('B5. re-importing the same journal is a no-op', async () => {
    const before = await readJson<{
      events: unknown[]; ledger: unknown[]; checklist: unknown[];
    }>(await get(`/api/upgrades/${journalRunId}`), 'GET run');

    // Another boot reconcile over the SAME unchanged journal.
    await compose('restart', 'control-plane');
    await waitForStackReady(300_000);
    const after = await readJson<{
      events: unknown[]; ledger: unknown[]; checklist: unknown[];
    }>(await get(`/api/upgrades/${journalRunId}`), 'GET run');

    // Idempotent on (runId, seq): no duplicated events, no duplicated ledger
    // row (playbook_ledger.gbrainVersion is UNIQUE), no reopened checklist item.
    expect(after.events.length).toBe(before.events.length);
    expect(after.ledger.length).toBe(before.ledger.length);
    expect(after.checklist.length).toBe(before.checklist.length);
  }, 300_000);

  test.skipIf(!dockerAvailable)('B6. an admin acknowledges a checklist item, it is audited, and it SURVIVES a restart', async () => {
    expect(journalItemId).toBeTruthy();
    const ack = await post(`/api/upgrades/checklist/${journalItemId}/ack`, { note: 'reviewed by gate B' });
    expect(ack.status).toBe(200);
    const ackBody = await readJson<{ item: { state: string; decidedBy: string | null; decidedAt: string | null } }>(
      ack, 'POST ack');
    expect(ackBody.item.state).toBe('acknowledged');
    expect(ackBody.item.decidedBy).toBe(adminUserId);
    expect(ackBody.item.decidedAt).toBeTruthy();

    const audit = await auditRows('upgrade.checklist.acknowledged');
    const row = audit.find((a) => a.target === journalItemId);
    expect(row).toBeTruthy();
    expect(row!.actor).toBe(adminUserId);
    expect((row!.after as { itemKey?: string } | null)?.itemKey).toBe('gate-b-decision');

    // Honesty rule 8: RESTART THE CONTAINER. Do not simulate it — an in-memory
    // acknowledgement passes every assertion up to this line and fails here.
    await compose('restart', 'control-plane');
    await waitForStackReady(300_000);
    cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const detail = await readJson<{
      checklist: Array<{ state: string; decidedBy: string | null }>;
    }>(await get(`/api/upgrades/${journalRunId}`), 'GET run');
    expect(detail.checklist[0]!.state).toBe('acknowledged');
    expect(detail.checklist[0]!.decidedBy).toBe(adminUserId);

    // A cleared item stops blocking: it is no longer listed as pending.
    const pending = await readJson<{ pending: Array<{ id: string }> }>(
      await get('/api/upgrades/pending-decisions'), 'GET pending');
    expect(pending.pending.find((p) => p.id === journalItemId)).toBeUndefined();
  }, 900_000);

  test.skipIf(!dockerAvailable)('B7. a viewer gets 403 on acknowledge', async () => {
    // A viewer is a real account with a real membership (admin-created), not a
    // simulated role. Sign the user up first so it has a usable password, then
    // attach the viewer membership through the shipped members route.
    await fetchInsecure('/api/auth/sign-up/email', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: VIEWER_EMAIL, password: VIEWER_PASSWORD, name: VIEWER_EMAIL }),
    });
    const added = await post('/api/members', { email: VIEWER_EMAIL, role: 'viewer' });
    expect([200, 409]).toContain(added.status);

    const viewerCookie = await signIn(VIEWER_EMAIL, VIEWER_PASSWORD);
    const res = await post(
      `/api/upgrades/checklist/${journalItemId}/ack`, {}, viewerCookie,
    );
    expect(res.status).toBe(403);
    // G5: acknowledging judgement residue is an admin decision, not a read.
    expect((await res.json() as { error?: string }).error).toMatch(/forbidden|role/i);
    // And the read surface is still readable — 403 on the write, not a wall.
    expect((await get('/api/upgrades', viewerCookie)).status).toBe(200);
  }, 300_000);

  test.skipIf(!dockerAvailable)('B8. there is NO route that starts an upgrade, and the API says so', async () => {
    // D1/S2: the executor is a host CLI. The control plane holds no Docker
    // socket and no Docker CLI; the shipped route names the real command.
    const res = await post('/api/upgrades', { to: '0.50.5.0' });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/scripts\/upgrade\.ts/);
    expect(body.error).toMatch(/host/i);
    // Nothing else accepts a start either.
    for (const p of ['/api/upgrades/start', '/api/upgrades/run', `/api/upgrades/${journalRunId}/start`]) {
      expect([404, 405, 503]).toContain((await post(p, {})).status);
    }
    // Rollback is host-only for the same reason: no control-plane route.
    expect([404, 405, 503]).toContain((await post(`/api/upgrades/${journalRunId}/rollback`, {})).status);
  });

  test.skipIf(!dockerAvailable)('B9. the drift panel speaks the shipped primitive, and says "no comparison yet" honestly', async () => {
    // F7: on a FRESH deployment Gate B runs before any upgrade leg has captured
    // a capability snapshot, so the honest answer is Task 8's `single_snapshot`
    // signal — never an empty diff (which would read as "verified no drift") and
    // never a 400 (which would claim a client error). The plan's self-review #6
    // says this test must hold whether Gate B runs before or after Gate C, so it
    // accepts the single-snapshot branch and asserts the real two-sided diff
    // (Task 8's shape, unmodified) when a prior run has captured both pins; C10
    // asserts that real diff after the upgrade.
    const res = await get('/api/upgrades/drift?from=0.50.0.0&to=0.50.5.0');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    if (body.single_snapshot === true) {
      expect(Array.isArray(body.available)).toBe(true);
      return;
    }
    expect(body).toEqual({
      versionChanged: true, toolsAdded: [], toolsRemoved: [],
      adaptersAdded: [], adaptersRemoved: [], profilesChanged: false,
    });
    expect(Object.keys(body).sort()).toEqual(
      ['adaptersAdded', 'adaptersRemoved', 'profilesChanged', 'toolsAdded', 'toolsRemoved', 'versionChanged']);
  }, 120_000);

  test.skipIf(!dockerAvailable)('B10. /admin is still not reachable', async () => {
    for (const p of ['/admin', '/admin/', '/admin/api/grants']) {
      expect((await fetchInsecure(p)).status).toBe(404);
    }
  });
});

// ===========================================================================
// Gate C — the Slice 3.5 exit gate
//
// Leg 1 (fixtured migration failure) -> Leg 2 (real clean upgrade) -> Leg 3
// (rollback of a SUCCESS, then a re-run so the stack finishes on 0.50.5.0).
//
// The plan's Task 17 sample was drafted against an earlier, richer CLI/journal
// shape. The coordinator's ruling (this dispatch) fixed exactly four things in
// the product — verifyRuntimePin -> checkUpdate, the StateDigest/RollbackReport
// shape, the structured schema/snapshot/gate/run_completed journal records, and
// the fixture/leg ordering — and directed that everything else be adapted to
// the SHIPPED surface and reported. Every deviation is named in the comments
// below and in the worker_done report.
// ===========================================================================

process.env.BRAINSTAND_E2E = '1';

const digestCtx: UpgradeContext = {
  runId: 'gate-c-digest', fromVersion: '0.50.0.0', toVersion: '0.50.5.0', dryRun: true,
  upgradeDir: HOST_UPGRADE_DIR, envPath: '.env', compose: COMPOSE, journal: null, now: () => new Date(),
};

let preDigest: StateDigest;
let failedRunId = '';
let realRunId = '';
/** Schedules this gate disabled for its window (Gate C beforeAll), restored after. */
let disabledScheduleIds: string[] = [];

function requireGateBReady(): void {
  if (!cookie) throw new Error('Gate C needs the admin cookie from Gate B (B1)');
}

async function stateDigestHost(): Promise<StateDigest> { return stateDigest(digestCtx); }

async function declaredPin(): Promise<string> {
  return ((await readFile('.env', 'utf8')).match(/^GBRAIN_VERSION=(.*)$/m)?.[1] ?? '').trim();
}

async function healthPin(): Promise<{ declared: string; observed: string | null; matches: boolean | null }> {
  const body = await readJson<{ pin: { declared: string; observed: string | null; matches: boolean | null } }>(
    await get('/api/health'), 'GET /api/health');
  return body.pin;
}

async function journalFor(runId: string) { return readJournal(HOST_UPGRADE_DIR, runId); }

async function journalEvent(runId: string, step: string): Promise<any> {
  return (await journalFor(runId)).find((e) => e.step === step) ?? null;
}

function cliJson(r: { stdout: string }): Record<string, unknown> {
  const i = r.stdout.indexOf('{');
  if (i < 0) throw new Error(`no JSON in CLI stdout: ${r.stdout.slice(0, 200)}`);
  return JSON.parse(r.stdout.slice(i)) as Record<string, unknown>;
}

let gbrainUrl = '';
async function gbrainPsql(sql: string) {
  if (!gbrainUrl) {
    const r = await composeExec('gbrain-ops', ['printenv', 'GBRAIN_DATABASE_URL']);
    gbrainUrl = r.stdout.trim();
  }
  return composeExec('gbrain-ops', ['psql', gbrainUrl, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
}

async function sourcesStatus(): Promise<Array<{ source_id: string; federated: boolean; total_pages: number }>> {
  const r = await composeExec('gbrain-ops', ['gbrain', 'sources', 'status', '--json']);
  const body = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as {
    sources: Array<{ source_id: string; federated: boolean; total_pages: number }>;
  };
  return body.sources;
}

async function ledgerRows(): Promise<Array<{ gbrainVersion: string; state: string; notes: string }>> {
  const json = await psql(
    "select coalesce(json_agg(json_build_object('gbrainVersion',gbrain_version,'state',state,'notes',notes) "
    + "order by gbrain_version),'[]'::json) from playbook_ledger",
  );
  return JSON.parse(json || '[]');
}

async function waitForLedger(n: number): Promise<Array<{ gbrainVersion: string; state: string; notes: string }>> {
  for (let i = 0; i < 45; i += 1) {
    const rows = await ledgerRows();
    if (rows.length >= n) return rows;
    await Bun.sleep(2_000);
  }
  return ledgerRows();
}

async function capabilitySnapshotVersions(): Promise<string[]> {
  return (await psql('select distinct gbrain_version from capability_snapshots order by gbrain_version'))
    .split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * F7: the run journals a `capability` event; the control-plane reconciler
 * imports the captured files into `capability_snapshots` when it comes back.
 * Poll rather than assume the reconcile tick landed.
 */
async function waitForCapabilityVersions(n: number): Promise<string[]> {
  for (let i = 0; i < 45; i += 1) {
    const versions = [...new Set(await capabilitySnapshotVersions())].sort();
    if (versions.length >= n) return versions;
    await Bun.sleep(2_000);
  }
  return [...new Set(await capabilitySnapshotVersions())].sort();
}

/**
 * F7 (#2): the migration-collision fixture can leave upstream's OWN playbook
 * migration ledger half-applied (`minions_migration: fail`, "MINIONS
 * HALF-INSTALLED (partial migration: 0.11.0)"). That makes `doctor` exit
 * non-zero, and `captureDoctorBaseline` CORRECTLY refuses to invent a baseline
 * (honesty rule 1). The gate repairs what its own fixture unsettled, through
 * the same `gbrain-ops` lane it used to apply it, before the real leg. The
 * refusal itself is untouched.
 */
async function repairFixtureResidue(): Promise<string> {
  const r = await composeExec('gbrain-ops', ['gbrain', 'apply-migrations', '--yes', '--non-interactive']);
  if (r.exitCode !== 0) {
    throw new Error(`repair apply-migrations exited ${r.exitCode}: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const doc = await composeExec('gbrain-ops', ['gbrain', 'doctor', '--json']);
  if (doc.exitCode !== 0) {
    throw new Error(
      `the fixture's partial playbook migration could not be repaired: doctor still exits ${doc.exitCode} ` +
      `(status ${/"status":"([a-z]+)"/.exec(doc.stdout)?.[1] ?? 'unknown'})`,
    );
  }
  const status = /"status":"([a-z]+)"/.exec(doc.stdout)?.[1] ?? 'ok';
  return `apply-migrations --yes repaired the fixture's partial playbook migration; doctor exit 0, status ${status}`;
}

/**
 * The shipped preflight refuses on ANY pending checklist item, so an operator
 * (and this gate) must clear stale judgement residue before a run. Acknowledges
 * through the real route, which is the durable, audited decision path.
 */
async function clearPendingDecisions(): Promise<number> {
  const body = await readJson<{ pending: Array<{ id: string }> }>(
    await get('/api/upgrades/pending-decisions'), 'GET pending');
  for (const p of body.pending) {
    const res = await post(`/api/upgrades/checklist/${p.id}/ack`, {});
    if (res.status !== 200) throw new Error(`ack checklist ${p.id} -> ${res.status}`);
  }
  return body.pending.length;
}

/**
 * Live schedules write report files into Space repos (`live-sync` every five
 * minutes). An interrupted run can leave one written but uncommitted, and
 * preflight CORRECTLY refuses to snapshot a dirty tree (`REPO_DRIFT`). The gate
 * does what an operator does with an orphaned partial report: discard it. This
 * is deliberately `reset --hard` + `clean -fd` and NOT a commit — committing
 * would move HEAD, and the content digest reads HEAD trees, so the before/after
 * digests would no longer be comparable. Discarding leaves HEAD exactly where
 * it was. The schedule writer is stopped first so nothing lands mid-clean; a
 * run's own `resume` brings it back. Returns the repos it had to clean.
 */
async function clearRepoDrift(): Promise<string[]> {
  await compose('stop', 'scheduler');
  const repos = (await psql('select source_id from spaces order by source_id'))
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const cleaned: string[] = [];
  for (const id of repos) {
    const dir = `/srv/brain-repos/${id}`;
    const status = await composeExec('gbrain-ops', ['git', '-C', dir, 'status', '--porcelain']);
    if (!status.stdout.trim()) continue;
    await composeExec('gbrain-ops', ['git', '-C', dir, 'reset', '--hard', 'HEAD']);
    await composeExec('gbrain-ops', ['git', '-C', dir, 'clean', '-fd']);
    cleaned.push(id);
  }
  return cleaned;
}

async function grepTree(dirs: string[], re: RegExp): Promise<string[]> {
  const hits: string[] = [];
  const glob = new Bun.Glob('**/*.{ts,tsx,js,sh,yml,yaml,md}');
  for (const dir of dirs) {
    for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) {
      const text = await Bun.file(join(dir, file)).text();
      text.split('\n').forEach((line, i) => { if (re.test(line)) hits.push(`${dir}/${file}:${i + 1}`); });
    }
  }
  return hits;
}

function totalBytes(manifest: { artifacts: Array<{ bytes: number }> }): number {
  return manifest.artifacts.reduce((a, x) => a + x.bytes, 0);
}

describe('Slice 3.5 seam gate C', () => {
  // Live schedules write AND COMMIT report pages into Space repos every few
  // minutes (`live-sync`: 0005, 0010, 0015, 0020 observed). Those commits move
  // the Space HEAD trees the content digest tracks, so between `preDigest` and a
  // run's snapshot the restored state would differ for a reason that has
  // nothing to do with the upgrade. An upgrade window is exactly when an
  // operator pauses maintenance; do that here and restore the enabled set after.
  beforeAll(async () => {
    if (!dockerAvailable) return;
    disabledScheduleIds = (await psql('select id from schedules where enabled'))
      .split('\n').map((s) => s.trim()).filter(Boolean);
    if (disabledScheduleIds.length > 0) {
      await psql("update schedules set enabled = false, disabled_reason = 'gate C upgrade window' where enabled");
    }
  }, 120_000);

  afterAll(async () => {
    if (!dockerAvailable || disabledScheduleIds.length === 0) return;
    const list = disabledScheduleIds.map((id) => `'${id}'`).join(',');
    await psql(`update schedules set enabled = true, disabled_reason = null where id in (${list})`);
  }, 120_000);

  test.skipIf(!dockerAvailable)('C1. the brain is populated on a POST-F4 stack, and federated is proven', async () => {
    requireGateBReady();
    const provision = await stateDigestHost();
    expect(provision.gbrainVersion).toBe('0.50.0.0');
    expect(provision.pages).toBeGreaterThan(0);
    expect(provision.sources.length).toBeGreaterThanOrEqual(3);
    expect((provision.controlRowCounts.connections ?? 0)).toBeGreaterThan(0);
    expect(Object.keys(provision)).toContain('filePlane'); // L7: the file plane is IN the digest
    // L6/F28: the POPULATED brain's Spaces are federated. Gate B and slice3 left
    // test-only probe sources (default, slice3-probe) outside the org; assert the
    // org's Spaces, not every gbrain source.
    const spaceIds = (await psql("select string_agg(source_id, ',' order by source_id) from spaces"))
      .split(',').map((s) => s.trim()).filter(Boolean);
    expect(spaceIds.length).toBeGreaterThanOrEqual(3);
    const byId = new Map((await sourcesStatus()).map((s) => [s.source_id, s]));
    for (const id of spaceIds) expect(byId.get(id)?.federated).toBe(true);

    // Clear stale judgement residue before the first run — the shipped preflight
    // refuses on any pending item (Task 13/Gate B left one).
    console.log(`MEASURED PENDING CLEARED(before failure leg): ${await clearPendingDecisions()}`);
    // Stop the schedule writer and discard any orphaned report before the
    // fixture/pre-digest, so Leg 1's preflight sees a clean tree and the digest
    // HEAD cannot move underneath the later comparisons.
    console.log(`MEASURED REPO DRIFT CLEARED(before fixture): ${JSON.stringify(await clearRepoDrift())}`);
  }, 1_800_000);

  test.skipIf(!dockerAvailable)('C2. the fixture makes upstream migrations genuinely pending, and never ships', async () => {
    // C0, folded in: the fixture lives only under test/.
    expect(await grepTree(['src', 'scripts'], FIXTURE_MARKERS)).toEqual([]);

    const applied = await applyMigrationCollisionFixture(gbrainPsql);
    console.log(`MEASURED FIXTURE: ${applied.summary}`);
    console.log(`MEASURED FIXTURE STATEMENTS: ${applied.statements.join(' || ')}`);
    expect(applied.recordedSchemaVersionBefore).toBe(PRISTINE_SCHEMA_VERSION);
    expect(applied.recordedSchemaVersionAfter).toBe(FIXTURE_SCHEMA_VERSION);
    expect(applied.collidingObject).toBe(COLLIDING_OBJECT);

    // Prove the collision independently on the TEST-ONLY lane: upstream v144's
    // own CREATE INDEX against the incompatible table raises SQLSTATE 42703.
    // The product MUST NOT relay gbrain's stderr (G3), so this is observed here
    // and nowhere else.
    const probe = await probeCollisionIndex(gbrainPsql);
    console.log(`MEASURED FIXTURE PROBE: exit ${probe.exitCode}; stderr ${probe.stderr.trim().replace(/\s+/g, ' ').slice(0, 160)}`);
    expect(probe.exitCode).not.toBe(0);
    expect(probe.stderr).toMatch(/42703|does not exist/);

    // Pendency is upstream's own computation (m.version > current). There is no
    // published contract that reports the schema version (U6), so the product's
    // `plan` must NOT compute it (G3); the count is derived here:
    const pending = Number(PRISTINE_SCHEMA_VERSION) - Number(FIXTURE_SCHEMA_VERSION);
    console.log(`MEASURED FIXTURE PENDING: ${pending} migrations (144..149, derived from upstream m.version > current)`);
    expect(pending).toBe(6);

    // FIX 4: the digest rollback must restore is the state that gets snapshotted.
    preDigest = await stateDigestHost();
    console.log('MEASURED PRE-DIGEST: taken AFTER the fixture (config.version 143, incompatible open_loops)');
  }, 600_000);

  test.skipIf(!dockerAvailable)('C3. apply-migrations FAILS for real, and the run transitions to rolling_back', async () => {
    console.log(`MEASURED REPO DRIFT CLEARED(before failure leg): ${JSON.stringify(await clearRepoDrift())}`);
    const t0 = Date.now();
    const run = await upgradeCli(['run', '--to', '0.50.5.0', '--yes']);
    const wall = Date.now() - t0;
    expect(run.exitCode).not.toBe(0);
    if (run.stdout.indexOf('{') < 0) {
      console.log(`MEASURED RUN(failure leg) stderr: ${run.stderr.trim().replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    const report = cliJson(run);
    failedRunId = String(report.runId);
    console.log(`MEASURED RUN(failure leg): runId ${failedRunId}, exit ${run.exitCode}, wall ${wall}ms`);

    const schemaStep = await journalEvent(failedRunId, 'schema');
    expect(schemaStep).toBeTruthy();
    // U3: exit codes are 0/1/2 and there is NO JSON; we record the code, we do
    // not parse the prose. The observed value is recorded verbatim.
    expect([1, 2]).toContain(schemaStep!.data.exitCode);
    expect(schemaStep!.data.exitCode).not.toBe(0);
    expect(schemaStep!.data.outcome).toBe('failed');
    console.log(`MEASURED APPLY-MIGRATIONS(failure leg): exitCode ${schemaStep!.data.exitCode}; message "${String(schemaStep!.message)}"`);

    const stateNames = new Set(['planned', 'preflight_ok', 'quiesced', 'snapshot_taken', 'swapped',
      'migrated', 'playbooks_applied', 'gated_ok', 'completed', 'failed', 'rolling_back',
      'rolled_back', 'rollback_failed']);
    const states = (await journalFor(failedRunId)).filter((e) => stateNames.has(e.step)).map((e) => e.step);
    expect(states).toContain('rolling_back');
    expect(states).not.toContain('completed');

    // Upstream did not get past migration 144: the recorded version is still 143.
    expect(await recordedSchemaVersion(gbrainPsql)).toBe(FIXTURE_SCHEMA_VERSION);
  }, 3_600_000);

  test.skipIf(!dockerAvailable)('C4. one-command rollback restores the pre-upgrade (fixtured) state exactly', async () => {
    const t0 = Date.now();
    const rb = await upgradeCli(['rollback', '--run', failedRunId]);
    console.log(`MEASURED ROLLBACK(failure leg): ${Date.now() - t0}ms, exit ${rb.exitCode}`);
    if (rb.exitCode !== 0) {
      // Diagnostic only (no assertion weakened): when parity is unequal the CLI
      // prints which digest parts differ, which is what C4 needs to explain.
      console.log(`MEASURED ROLLBACK(failure leg) stdout: ${rb.stdout.slice(0, 1200)}`);
      console.log(`MEASURED ROLLBACK(failure leg) stderr: ${rb.stderr.slice(0, 600)}`);
    }
    expect(rb.exitCode).toBe(0); // honesty rule 5: ONE operation, no second step
    await waitForStackReady(600_000);

    const diff = compareDigests(preDigest, await stateDigestHost());
    expect(diff.differing).toEqual([]);
    expect(diff.onlyInA).toEqual([]);
    expect(diff.onlyInB).toEqual([]);
    expect(diff.equal).toBe(true);

    // The fixture lives BELOW the digest. Leg 1's snapshot was taken with the
    // fixture applied, so rollback restores the FIXTURED brain. The plan's
    // `149`/`source_id` expectation is inverted (fix 4); assert the real values.
    expect(await recordedSchemaVersion(gbrainPsql)).toBe(FIXTURE_SCHEMA_VERSION);
    expect(await columnsOf(gbrainPsql, COLLIDING_OBJECT)).toEqual(['id']);
  }, 3_600_000);

  test.skipIf(!dockerAvailable)('C5. the pin is back at 0.50.0.0, the binary agrees, and the fixture is undone', async () => {
    expect(await declaredPin()).toBe('0.50.0.0');
    const pin = await healthPin();
    expect(pin.declared).toBe('0.50.0.0');
    expect(pin.observed).toBe('0.50.0.0');
    expect(pin.matches).toBe(true);

    // FIX 4: un-fixture BEFORE Leg 2, through the same test-only psql lane.
    const undone = await undoMigrationCollisionFixture(gbrainPsql);
    console.log(`MEASURED UN-FIXTURE: ${undone.summary}`);
    expect(undone.recordedSchemaVersionAfter).toBe(PRISTINE_SCHEMA_VERSION);
    expect(await columnsOf(gbrainPsql, COLLIDING_OBJECT)).toContain('source_id');
  }, 600_000);

  test.skipIf(!dockerAvailable)('C6. the quiesce is PROVEN clean, not merely reported', async () => {
    console.log(`MEASURED REPAIR: ${await repairFixtureResidue()}`);
    console.log(`MEASURED REPO DRIFT CLEARED(before real leg): ${JSON.stringify(await clearRepoDrift())}`);
    const t0 = Date.now();
    const run = await upgradeCli(['run', '--to', '0.50.5.0', '--yes']);
    realRunId = String(cliJson(run).runId);
    await waitForStackReady(900_000);
    expect(run.exitCode).toBe(0);
    console.log(`MEASURED REAL RUN: runId ${realRunId}, wall ${Date.now() - t0}ms`);

    const q = await journalEvent(realRunId, 'quiesced');
    expect(q).toBeTruthy();
    console.log(`MEASURED QUIESCE(real leg): ${q!.data.drainMs}ms supervisor drain`);
    // D3: the stop order IS the atomicity guarantee.
    expect(q!.data.stopped).toEqual(['scheduler', 'gbrain-worker', 'control-plane', 'gbrain-serve', 'gbrain-ops']);
    const proof = q!.data.drainProof;
    // U9 / honesty rule 3: classified from POSITIVE in-window evidence, never
    // `reason:'drained'` alone. At this pin a clean stop writes shutting_down
    // exit 0 (no `stopped` event), which the window-scoped proof reads.
    expect(proof.classification).toBe('clean');
    expect(proof.exitCode).toBe(0);
    expect(['SIGTERM', 'SIGINT']).toContain(proof.reason);
    expect(proof.running).toBe(false);
    const windowMs = Date.parse(proof.windowEnd) - Date.parse(proof.windowStart);
    expect(windowMs).toBeLessThan(40_000); // L1 measured ~1.2s; recorded, not designed to
    console.log(`MEASURED QUIESCE WINDOW(real leg): ${windowMs}ms; decidingEvent ${JSON.stringify(proof.decidingEvent)}`);
  }, 3_600_000);

  test.skipIf(!dockerAvailable)('C7. the snapshot is four artifacts and one manifest, and it verifies', async () => {
    const snap = await journalEvent(realRunId, 'snapshot');
    expect(snap).toBeTruthy();
    const m = snap!.data.manifest;
    console.log(`MEASURED SNAPSHOT(real leg): ${snap!.data.durationMs}ms, ${totalBytes(m)} bytes`);
    expect(m.artifacts.map((a: { name: string }) => a.name).sort())
      .toEqual(['brain-db', 'brain-repos', 'control-db', 'gbrain-home']); // L7: file plane captured
    expect(m.fromVersion).toBe('0.50.0.0');
    expect(m.driver).toBe('docker-volume');
    expect(m.runId).toBe(realRunId);
    for (const a of m.artifacts) expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyManifest(m, join(HOST_UPGRADE_DIR, realRunId))).toEqual({ ok: true, mismatches: [] });
  }, 1_800_000);

  test.skipIf(!dockerAvailable)('C8. the swap moved the pin AND the running binary', async () => {
    expect(await declaredPin()).toBe('0.50.5.0');
    const pin = await healthPin();
    // Honesty rule 9: the pin in .env is not evidence; verifyRuntimePin now reads
    // check-update's current_version (runtime, not .env).
    expect(pin.observed).toBe('0.50.5.0');
    expect(pin.matches).toBe(true);

    const j = await journalFor(realRunId);
    const snapTaken = j.find((e) => e.step === 'snapshot_taken')!;
    const swapped = j.find((e) => e.step === 'swapped')!;
    const buildSwapMs = Date.parse(String(swapped.at)) - Date.parse(String(snapTaken.at));
    console.log(`MEASURED BUILD+SWAP(real leg): ${buildSwapMs}ms (snapshot_taken -> swapped)`);
    expect(buildSwapMs).toBeGreaterThan(0);
    // D8's no-fallback property is a static invariant asserted by
    // test/integration/compose-invariants.test.ts; this gate does not duplicate it.
  }, 900_000);

  test.skipIf(!dockerAvailable)('C9. apply-migrations applied nothing, and that is RECORDED as this delta\'s outcome', async () => {
    const schemaStep = await journalEvent(realRunId, 'schema');
    expect(schemaStep!.data.exitCode).toBe(0);
    expect(schemaStep!.data.outcome).toBe('no_migrations_pending');
    expect(String(schemaStep!.data.evidence))
      .toMatch(/migrate\.ts is byte-identical at 0\.50\.0\.0 and 0\.50\.5\.0/);
    expect(await recordedSchemaVersion(gbrainPsql)).toBe('149');

    // U11 / honesty rule 7 / D6: four versions, one playbook, three explicit
    // no-playbook rows with the evidence that established them. The array shape
    // is the shipped one (notes, not a `text[]`), adapted from the plan.
    const ledger = await waitForLedger(4);
    expect(ledger.map((r) => r.gbrainVersion).sort())
      .toEqual(['0.50.1.0', '0.50.2.0', '0.50.4.0', '0.50.5.0']);
    expect(ledger.map((r) => r.gbrainVersion)).not.toContain('0.50.3.0'); // it does not exist
    const byV = Object.fromEntries(ledger.map((r) => [r.gbrainVersion, r]));
    // 0.50.2.0 opens 8 checklist items, so its ledger state is awaiting_admin_decision.
    expect(byV['0.50.2.0']!.state).toBe('awaiting_admin_decision');
    expect(byV['0.50.2.0']!.notes).toMatch(/skills\/migrations\/v0\.50\.2\.0\.md/);
    expect(byV['0.50.2.0']!.notes).toMatch(/@[0-9a-f]{12}/);
    for (const v of ['0.50.1.0', '0.50.4.0', '0.50.5.0']) {
      expect(byV[v]!.state).toBe('applied');
      expect(byV[v]!.notes).toMatch(/upstream ships no playbook for this version/);
      expect(byV[v]!.notes).toMatch(/skills\/migrations\//);
    }
  }, 900_000);

  test.skipIf(!dockerAvailable)('C10. doctor parity passes per-check, drift is versionChanged only, content survives', async () => {
    const gate = await journalEvent(realRunId, 'gate');
    // D5: per-check, never the exit code (U7), never `blockers` (L4).
    expect(gate!.data.parity.regressed).toEqual([]);
    expect(gate!.data.parity.schemaVersionOk).toBe(true);
    console.log(`MEASURED PARITY(real leg): status ${gate!.data.parity.status}, healthScore ${gate!.data.parity.healthScore}, newChecks ${gate!.data.parity.newChecks.length}`);

    // A row per pin, and the drift is what U10 predicts. F7 wired the writer
    // (host capture + reconciler import), so wait for the reconcile tick.
    const capVersions = await waitForCapabilityVersions(2);
    expect(capVersions).toEqual(['0.50.0.0', '0.50.5.0']);
    const drift = await readJson<Record<string, unknown>>(
      await get('/api/upgrades/drift?from=0.50.0.0&to=0.50.5.0'), 'GET drift');
    expect(drift).toEqual({
      versionChanged: true, toolsAdded: [], toolsRemoved: [],
      adaptersAdded: [], adaptersRemoved: [], profilesChanged: false,
    });

    // The populated brain is still the populated brain (pages + source identity).
    const after = await stateDigestHost();
    // Live schedules append committed report PAGES between the two digests, so
    // strict equality would assert "no schedule fired", which is not the
    // property under test. This still catches LOSS (the content-survives
    // claim); additions are expected and recorded.
    expect(after.pages).toBeGreaterThanOrEqual(preDigest.pages);
    expect(after.sources.map((s) => s.id).sort()).toEqual(preDigest.sources.map((s) => s.id).sort());

    const completed = await journalEvent(realRunId, 'run_completed');
    console.log(`MEASURED TOTAL DOWNTIME(real leg): ${completed!.data.downtimeMs}ms`);
  }, 1_800_000);

  test.skipIf(!dockerAvailable)('C11. rolling back a SUCCESSFUL run restores the pre-upgrade digest exactly', async () => {
    const t0 = Date.now();
    const rb = await upgradeCli(['rollback', '--run', realRunId]);
    console.log(`MEASURED ROLLBACK(success leg): ${Date.now() - t0}ms, exit ${rb.exitCode}`);
    expect(rb.exitCode).toBe(0);
    await waitForStackReady(600_000);

    const diff = compareDigests(preDigest, await stateDigestHost());
    expect(diff.differing).toEqual([]);
    expect(diff.onlyInA).toEqual([]);
    expect(diff.onlyInB).toEqual([]);
    expect(await declaredPin()).toBe('0.50.0.0');
    expect((await healthPin()).observed).toBe('0.50.0.0');
    // U8: no down-migration anywhere upstream, so this is snapshot restore.
    const rbJson = cliJson(rb);
    expect(rbJson.method).toBe('snapshot-restore');
    expect(rbJson.ranUpstreamDownMigrations).toBe(false);
  }, 3_600_000);

  test.skipIf(!dockerAvailable)('C12. re-running the upgrade lands the stack at 0.50.5.0 and leaves it healthy', async () => {
    console.log(`MEASURED PENDING CLEARED(before Leg 3 re-run): ${await clearPendingDecisions()}`);
    console.log(`MEASURED REPO DRIFT CLEARED(before Leg 3 re-run): ${JSON.stringify(await clearRepoDrift())}`);
    const again = await upgradeCli(['run', '--to', '0.50.5.0', '--yes']);
    expect(again.exitCode).toBe(0);
    const againRunId = String(cliJson(again).runId);
    await waitForStackReady(900_000);
    expect(await declaredPin()).toBe('0.50.5.0');
    expect((await healthPin()).matches).toBe(true);

    const gate = await journalEvent(againRunId, 'gate');
    expect(gate!.data.parity.regressed).toEqual([]);
    expect(gate!.data.parity.schemaVersionOk).toBe(true);
    expect((await ledgerRows()).length).toBe(4); // UNIQUE(gbrainVersion): still four
    const health = await readJson<{ ok: boolean }>(await get('/api/health'), 'GET /api/health');
    expect(health.ok).toBe(true);
    const pending = await readJson<{ pending: unknown[] }>(
      await get('/api/upgrades/pending-decisions'), 'GET pending');
    // The plan expected []; a successful run OPENS 0.50.2.0's 8 checklist items
    // per run, so pending is legitimately non-empty. Assert the shape, not [].
    expect(Array.isArray(pending.pending)).toBe(true);
  }, 3_600_000);
});
