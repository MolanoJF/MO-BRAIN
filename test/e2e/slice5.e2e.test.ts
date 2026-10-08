import './host-ops-env.ts';
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackup } from '../../scripts/backup.ts';
import { runRestore } from '../../scripts/restore.ts';
import { brainUsage } from '../../src/control/opsClient.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { scrubOutput } from '../../src/docker/host.ts';
import { writePin } from '../../src/contracts/pin.ts';
import { readJournal } from '../../src/upgrade/journal.ts';
import { stateDigest, compareDigests, type StateDigest } from '../../src/upgrade/digest.ts';
import type { UpgradeContext } from '../../src/upgrade/types.ts';
import {
  applyMigrationCollisionFixture, undoMigrationCollisionFixture,
  recordedSchemaVersion, columnsOf, COLLIDING_OBJECT,
  PRISTINE_SCHEMA_VERSION, FIXTURE_SCHEMA_VERSION,
} from './fixtures/migration-collision.ts';

/**
 * Slice 5 Gate C — the GA operator walk (C1–C10).
 *
 * One continuous walk by one operator on one stack. C1 and C7–C8 were written
 * by Tasks 8 and 16 and are kept as they are; C2–C6, C9 and C10 are assembled
 * here. The walk does what a new customer does in their first week: read the
 * door, see the modes, invite a teammate, run a command schedule, run an agent,
 * read the bill, back up, restore, upgrade, and count the money.
 *
 * The live-state warnings this file inherits (docs/archive/superpowers/plans/
 * 2026-09-18-slice-5-self-host-ga.md, "Live-state warnings"):
 *
 *   * The stored `anthropic_api_key` is a rotating host secret. C5 is a money
 *     leg; a stale token answers `401 authentication_error` and looks like a
 *     defect. Re-provision host-side AFTER a destructive cycle.
 *   * The brain is thin, so C3–C5 start from little content.
 *   * A restore or quiesce leaves the runner DOWN by design; C9 brings it back.
 *   * `test/integration/quiesce.test.ts` drops the dev port publication; re-up
 *     the dev stack before this file.
 *
 * No assertion in this file was moved to accommodate a defect. Where the live
 * stack cannot do what the plan literally promises (C2's "fresh operator"),
 * the leg asserts the product's real behaviour at that surface and the gap is
 * recorded in `docs/slice-5-findings.md`.
 */

const SKIP_SLICE5_E2E_ENV = 'MOBRAIN_ALLOW_SKIP_SLICE5_E2E';

// The migration-collision fixture (C9) is test-only and refuses to run unless
// this deployment is an e2e stack. slice35.e2e.test.ts's Gate C sets the same
// guard before it applies the fixture.
process.env.MOBRAIN_E2E = '1';

const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8443';
const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PASSWORD = 'a-long-enough-password';
const RUN_ID = Date.now().toString(36);

// The pin the stack runs at, and the pin Slice 3.5's upgrade gate starts from.
// The pin this release ships (`HANDOFF.md`), independent of the MUTABLE `.env`:
// C9's own rollback rewrites `.env`, and Bun loads it into `process.env` at
// startup, so reading the target from there would make the run a SAME_VERSION
// refusal after the first pass.
const TARGET_PIN = '0.50.5.0';
const FROM_PIN = '0.50.0.0';

process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

/**
 * The host directory the control-plane bind-mounts read-only at /srv/upgrades
 * (D1/D2). Mirrors `slice35.e2e.test.ts` exactly and on purpose: the upgrade
 * journal is shared with that file's Gate C and with Slice 4's, so a different
 * directory would hide the runs C9 rolls back.
 */
const HOST_UPGRADE_DIR = process.env.UPGRADE_DIR ?? join(tmpdir(), 'mobrain-upgrade-e2e');
process.env.UPGRADE_DIR = HOST_UPGRADE_DIR;

const COMPOSE_ENV: Record<string, string> = {
  ...process.env as Record<string, string>,
  DOMAIN: process.env.DOMAIN ?? 'localhost',
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? 'change-me-in-a-real-deployment',
  OPS_RPC_TOKEN: process.env.OPS_RPC_TOKEN ?? 'compose-exec-placeholder',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? 'compose-exec-placeholder-32-characters',
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'compose-exec-placeholder-32-characters',
};

// `.env` is the single source of the pin: the upgrade MOVES it, and an ambient
// GBRAIN_VERSION once made every compose call after the swap run the old tag
// (slice35.e2e.test.ts's measured defect).
delete COMPOSE_ENV.GBRAIN_VERSION;

const COMPOSE = [
  'docker', 'compose',
  ...(existsSync('.env') ? ['--env-file', '.env'] as const : []),
  '-f', 'compose/docker-compose.yml',
  '-f', 'compose/docker-compose.dev.yml',
];

const fetchInsecure = (path: string, init?: RequestInit) =>
  fetch(`${BASE}${path}`, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);

async function probeDockerCompose(): Promise<boolean> {
  try {
    return (await Bun.$`docker compose version`.quiet().nothrow()).exitCode === 0;
  } catch {
    return false;
  }
}

const dockerAvailable = await probeDockerCompose();

async function composeArgs(env: Record<string, string>, ...args: string[]) {
  const p = Bun.spawn([...COMPOSE, ...args], { stdout: 'pipe', stderr: 'pipe', env });
  const timer = setTimeout(() => p.kill(), 1_800_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

const compose = (...args: string[]) => composeArgs(COMPOSE_ENV, ...args);

async function composeExec(
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

/** The live control DB, through its own container (it publishes no host port). */
async function psql(sql: string): Promise<string> {
  const r = await composeExec('postgres', ['psql', '-U', 'gbrain', '-d', 'control', '-tAc', sql]);
  if (r.exitCode !== 0) throw new Error(`psql failed (${r.exitCode}): ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const one = (v: string): string => v.split(/\r?\n/)[0] ?? '';

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

async function readJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new Error(`${label} ${res.status} ${ct}: ${text.slice(0, 300)}`);
  }
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`${label} ${res.status} unparseable: ${text.slice(0, 300)}`); }
}

/** For responses that might carry a credential: never paste the body. */
async function readJsonQuiet<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`${label}: ${res.status} unparseable; the body is withheld on purpose`); }
}

async function waitFor<T>(
  label: string, timeoutMs: number, poll: () => Promise<T | null>, everyMs = 1_500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = await poll();
    if (seen !== null) return seen;
    await Bun.sleep(everyMs);
  }
  throw new Error(`${label}: not observed within ${timeoutMs}ms`);
}

type Health = {
  ok: boolean;
  components: Record<string, string>;
  pin: { declared: string; observed: string | null; matches: boolean | null };
  runner: { state: string; lastSeenAt: string | null; version: string | null };
};

async function healthNow(): Promise<Health> {
  const res = await fetchInsecure('/api/health');
  expect(res.status).toBe(200);
  return await res.json() as Health;
}

async function waitForHealth(
  accept: (h: Health) => boolean, timeoutMs: number, label: string,
): Promise<Health> {
  const deadline = Date.now() + timeoutMs;
  let last: Health | null = null;
  while (Date.now() < deadline) {
    try {
      last = await healthNow();
      if (accept(last)) return last;
    } catch { /* the recreate window */ }
    await Bun.sleep(2_000);
  }
  throw new Error(`${label}: /api/health never said so within ${timeoutMs}ms (last ${JSON.stringify(last?.runner ?? null)})`);
}

async function waitForStackReady(timeoutMs = 240_000): Promise<void> {
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

async function waitForOpsRpc(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch('http://127.0.0.1:3140/healthz', { signal: AbortSignal.timeout(5_000) })).ok) return;
    } catch { /* down */ }
    await Bun.sleep(500);
  }
  throw new Error(`the ops RPC at 127.0.0.1:3140 never answered /healthz within ${timeoutMs}ms`);
}

// --- the schedule lane's HTTP surface ----------------------------------------

type RunRow = {
  id: string;
  slot: string;
  fireAt: string;
  state: string;
  exitCode: number | null;
  classification: string | null;
  reportPath: string | null;
  summary: { status?: string | null; error?: string; changed?: number | null } | null;
};

const TERMINAL = ['succeeded', 'failed', 'held', 'cancelled'];

function scheduledPost(path: string, body: unknown, cookie: string) {
  return fetchInsecure(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

/** Poll one schedule's newest run via the published runs route. */
async function waitForRunState(
  scheduleId: string, wanted: readonly string[], timeoutMs: number, cookie: string,
): Promise<RunRow> {
  const deadline = Date.now() + timeoutMs;
  let last: RunRow | null = null;
  while (Date.now() < deadline) {
    const body = await readJson<{ runs: RunRow[] }>(
      await fetchInsecure(`/api/schedules/${scheduleId}/runs`, { headers: { cookie } }), 'GET runs');
    last = body.runs[0] ?? null;
    if (last && wanted.includes(last.state)) return last;
    await Bun.sleep(2_000);
  }
  throw new Error(`schedule ${scheduleId} produced no terminal run within ${timeoutMs}ms (last ${JSON.stringify(last)})`);
}

type ConnectionRow = {
  id: string;
  membershipId: string;
  writeSpaceId: string;
  state: string;
  clientName: string;
  compiled?: { sourceId: string; federatedRead: string[] };
};

async function listConnections(cookie: string): Promise<ConnectionRow[]> {
  const res = await fetchInsecure('/api/connections', { headers: { cookie } });
  if (res.status !== 200) throw new Error(`GET /api/connections -> ${res.status} ${await res.text()}`);
  return ((await res.json()) as { connections: ConnectionRow[] }).connections;
}

// --- the gbrain-ops container's read-only and test-only lanes ----------------

/** Read-only verbs in the Space repos, through the container that holds them. */
async function opsExec(argv: string[], timeoutMs = 120_000) {
  const p = Bun.spawn([...COMPOSE, 'exec', '-T', 'gbrain-ops', ...argv], {
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

type SqlResult = { exitCode: number; stdout: string; stderr: string };

let gbrainUrl = '';
/** The test-only psql lane the migration fixture uses (G3: never an RPC op). */
async function gbrainPsql(sql: string): Promise<SqlResult> {
  if (!gbrainUrl) {
    const r = await composeExec('gbrain-ops', ['printenv', 'GBRAIN_DATABASE_URL']);
    gbrainUrl = r.stdout.trim();
  }
  return composeExec('gbrain-ops', ['psql', gbrainUrl, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
}

/** The tail of the last JSON value a gbrain CLI printed, or null. */
function parseLastJson(text: string): unknown | null {
  const trimmed = text.trim();
  const start = Math.min(
    ...[trimmed.indexOf('{'), trimmed.indexOf('[')].filter((i) => i >= 0),
  );
  if (!Number.isFinite(start) || start < 0) return null;
  try { return JSON.parse(trimmed.slice(start)); } catch { return null; }
}

// The thin-client flow needs `NODE_TLS_REJECT_UNAUTHORIZED=0` and `GBRAIN_HOME`
// in the container. `docker compose exec` does not forward the host env, so the
// vars cross with `-e` — slice2's own measured shape.
async function composeExecEnv(
  service: string, argv: string[], env: Record<string, string>, timeoutMs = 120_000,
) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const p = Bun.spawn([...COMPOSE, 'exec', '-T', ...envArgs, service, ...argv], {
    stdout: 'pipe', stderr: 'pipe', env: COMPOSE_ENV,
  });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { exitCode, stdout: scrubOutput(stdout), stderr: scrubOutput(stderr) };
  } finally { clearTimeout(timer); }
}

// --- shared state ------------------------------------------------------------

let adminCookie = '';
const WALK_SCHEDULES: string[] = [];
const WALK_MEMBER_EMAIL = `walk-${RUN_ID}@example.test`;
let walkConnectionId = '';
let walkWriteSource = '';
let c5RunId = '';
let c5MemberEmail = WALK_MEMBER_EMAIL;
let fixtureApplied = false;
let disabledScheduleIds: string[] = [];
let preDigest: StateDigest | null = null;
/** C7's archive; C8 restores it. */
let backupDir = '';
/**
 * C10's measurement, captured at C6 — the last moment the walk's rows exist.
 * C9's own rollback restores a control-DB snapshot that predates the walk, so
 * a teardown-only query would honestly report `$0.0000000` about a walk that
 * spent real money.
 */
let c10Spend: Array<Record<string, unknown>> | null = null;

// --- C9's host-side upgrade seam ---------------------------------------------

function cliJson(r: { stdout: string }): Record<string, unknown> {
  const i = r.stdout.indexOf('{');
  if (i < 0) throw new Error(`no JSON in CLI stdout: ${r.stdout.slice(0, 200)}`);
  return JSON.parse(r.stdout.slice(i)) as Record<string, unknown>;
}

async function upgradeCli(args: string[], env: Record<string, string> = {}) {
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

async function declaredPin(): Promise<string> {
  return ((await readFile('.env', 'utf8')).match(/^GBRAIN_VERSION=(.*)$/m)?.[1] ?? '').trim();
}

async function journalFor(runId: string) { return readJournal(HOST_UPGRADE_DIR, runId); }

async function journalEvent(runId: string, step: string) {
  return (await journalFor(runId)).find((e) => e.step === step) ?? null;
}

/** Every metered agent run this walk created, per run, with its call count. */
async function measureWalkSpend(): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await psql(
    "select coalesce(json_agg(json_build_object('schedule',s.name,'run',a.run_id,"
    + "'state',r.state,'class',r.classification,'cost',a.cost_usd,"
    + "'in',a.input_tokens,'out',a.output_tokens,"
    + "'calls',(select count(*) from agent_run_usage u where u.run_id = a.run_id)) "
    + "order by r.created_at), '[]'::json) from agent_runs a "
    + "join schedule_runs r on r.id = a.run_id join schedules s on s.id = r.schedule_id "
    + `where s.name like 'walk-%${RUN_ID}%'`,
  )) as Array<Record<string, unknown>>;
}

async function ledgerRows(): Promise<Array<{ gbrainVersion: string; state: string }>> {
  return JSON.parse(await psql(
    "select coalesce(json_agg(json_build_object('gbrainVersion',gbrain_version,'state',state) "
    + "order by gbrain_version),'[]'::json) from playbook_ledger",
  )) as Array<{ gbrainVersion: string; state: string }>;
}

/** Preflight refuses on any pending decision; acknowledge through the real route. */
async function clearPendingDecisions(): Promise<number> {
  const body = await readJson<{ pending: Array<{ id: string }> }>(
    await fetchInsecure('/api/upgrades/pending-decisions', { headers: { cookie: adminCookie } }), 'GET pending');
  for (const p of body.pending) {
    const res = await scheduledPost(`/api/upgrades/checklist/${p.id}/ack`, {}, adminCookie);
    if (res.status !== 200) throw new Error(`ack checklist ${p.id} -> ${res.status}`);
  }
  return body.pending.length;
}

/** Discard an orphaned uncommitted report; never commit (it would move HEAD). */
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

function digestCtx(from: string, to: string): UpgradeContext {
  return {
    runId: 'gate-c-digest', fromVersion: from, toVersion: to, dryRun: true,
    upgradeDir: HOST_UPGRADE_DIR, envPath: '.env', compose: COMPOSE, journal: null, now: () => new Date(),
  };
}

async function stateDigestHost(from: string, to: string): Promise<StateDigest> {
  return stateDigest(digestCtx(from, to));
}

/** The newest journal run that STARTED at `fromVersion` and COMPLETED. */
async function latestCompletedRunFromPin(fromVersion: string): Promise<string | null> {
  const entries = await readdir(HOST_UPGRADE_DIR, { withFileTypes: true }).catch(() => []);
  let best: { id: string; mtimeMs: number } | null = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(HOST_UPGRADE_DIR, e.name);
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { fromVersion?: string };
      if (manifest.fromVersion !== fromVersion) continue;
      const journal = await readFile(join(dir, 'journal.ndjson'), 'utf8');
      if (!journal.split('\n').some((l) => l.includes('"step":"completed"'))) continue;
      const s = await stat(join(dir, 'manifest.json'));
      if (!best || s.mtimeMs > best.mtimeMs) best = { id: e.name, mtimeMs: s.mtimeMs };
    } catch { /* not a run dir */ }
  }
  return best?.id ?? null;
}

// --- C3's thin client (the same flow slice2 proves) --------------------------

async function pointLocalhostAtCaddy(): Promise<void> {
  const dns = await composeExec('gbrain-ops', ['getent', 'hosts', 'caddy']);
  const ip = dns.stdout.trim().split(/\s+/)[0];
  if (!ip) throw new Error(`could not resolve caddy: ${dns.stderr}`);
  const script =
    `const fs = require('fs');`
    + `const hosts = fs.readFileSync('/etc/hosts','utf8');`
    + `if (!fs.existsSync('/tmp/hosts.slice5.bak')) fs.writeFileSync('/tmp/hosts.slice5.bak', hosts);`
    + `const next = hosts.replace(/127\\.0\\.0\\.1\\s+localhost/g, ${JSON.stringify(ip)} + ' localhost')`
    + `.replace(/172\\.\\d+\\.\\d+\\.\\d+\\s+localhost/g, ${JSON.stringify(ip)} + ' localhost');`
    + `fs.writeFileSync('/etc/hosts', next);`;
  const r = await composeExec('gbrain-ops', ['bun', '-e', script]);
  if (r.exitCode !== 0) throw new Error(`hosts rewrite failed: ${r.stderr}`);
}

async function restoreLocalhost(): Promise<void> {
  const script =
    `const fs = require('fs');`
    + `if (fs.existsSync('/tmp/hosts.slice5.bak')) fs.writeFileSync('/etc/hosts', fs.readFileSync('/tmp/hosts.slice5.bak'));`;
  await composeExec('gbrain-ops', ['bun', '-e', script]).catch(() => undefined);
}

type ClaimConnection = {
  connectionId: string;
  credentials: { client_id?: string; client_secret?: string };
  mcp_url: string;
};

async function initThinClient(home: string, cred: ClaimConnection): Promise<void> {
  const issuerUrl = (cred.mcp_url.replace(/\/mcp\/?$/, '') || 'https://localhost');
  const argv = buildArgv(OPERATIONS['init.mcpOnly']!, {
    issuerUrl, mcpUrl: cred.mcp_url,
    oauthClientId: cred.credentials.client_id,
    oauthClientSecret: cred.credentials.client_secret,
    force: true,
  }, { json: true });
  const raw = await composeExecEnv('gbrain-ops', ['gbrain', ...argv], {
    GBRAIN_HOME: home, NODE_TLS_REJECT_UNAUTHORIZED: '0',
  }, 180_000);
  if (raw.exitCode !== 0) throw new Error(`init.mcpOnly failed (exit ${raw.exitCode}): ${raw.stderr || raw.stdout}`);
}

function searchHits(json: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(json)) return json as Array<Record<string, unknown>>;
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    for (const k of ['results', 'hits', 'items']) if (Array.isArray(o[k])) return o[k] as Array<Record<string, unknown>>;
  }
  return [];
}

function hitSourceIds(hits: Array<Record<string, unknown>>): string[] {
  return hits.map((r) => (r.source_id ?? r.sourceId) as string | undefined)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
}

// --- beforeAll / afterAll ----------------------------------------------------

async function ensureRunnerUp(): Promise<void> {
  // A recreate answers 502 for a moment; wait for a reading rather than let one
  // transient failure skip the bring-up entirely.
  const health = await waitForHealth(() => true, 120_000, 'a health reading before ensuring the runner');
  if (health.runner.state === 'connected') return;
  await compose('--profile', 'runner', 'up', '-d', 'caddy-ca-export', 'agent-runner');
  await waitForHealth((h) => h.runner.state === 'connected', 180_000, 'the runner lane to be connected');
}

beforeAll(async () => {
  if (!dockerAvailable) return;
  await (await import('node:fs/promises')).mkdir(HOST_UPGRADE_DIR, { recursive: true });

  let reachable = false;
  try { reachable = (await fetchInsecure('/api/health')).status < 500; } catch { /* cold */ }
  if (!reachable) {
    const up = await compose('up', '-d', '--wait');
    if (up.exitCode !== 0) throw new Error(`compose up failed: ${up.stderr || up.stdout}`);
  }
  await waitForStackReady(300_000);
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  // C1/C7/C8 and the money legs stand on the published ops port. A run after
  // `test/integration` — or after C9's own upgrade, whose resume uses the BASE
  // compose file — finds it dropped; re-up rather than fail on connection
  // refused. The second `waitForStackReady` is the fix for a measured race: a
  // recreate answers 200 on one probe and 502 on the next, so returning on the
  // ops read alone let C2–C6 hit the window.
  await waitForOpsRpc(60_000).catch(async () => {
    await compose('up', '-d', '--wait');
    await waitForStackReady(300_000);
    await waitForOpsRpc(120_000);
  });
}, 900_000);

afterAll(async () => {
  if (backupDir) await rm(backupDir, { recursive: true, force: true });
  if (!dockerAvailable) return;
  await restoreLocalhost();
  // C10 — the walk's total model spend, read from the gate's own rows BEFORE
  // the fixtures (and their cascading runs) are deleted, exactly as Slice 4's
  // Gate C does. C9's rollback can erase the walk first, so C6 captured it.
  const spend = c10Spend ?? await measureWalkSpend();
  let total = 0;
  for (const row of spend) {
    total += Number(row.cost ?? 0);
    console.log(`MEASURED C10 spend ${JSON.stringify(row)}`);
  }
  console.log(`MEASURED C10 the GA walk total model spend = $${total.toFixed(7)} over ${spend.length} run(s)`);

  for (const id of WALK_SCHEDULES) {
    await psql(
      `delete from schedule_alerts where run_id in (select id from schedule_runs where schedule_id = '${id}') `
      + `or schedule_id = '${id}'; delete from schedules where id = '${id}'`,
    ).catch(() => undefined);
  }
  if (fixtureApplied) {
    await undoMigrationCollisionFixture(gbrainPsql).catch(() => undefined);
    fixtureApplied = false;
  }
  if (disabledScheduleIds.length > 0) {
    const list = disabledScheduleIds.map((id) => `'${id}'`).join(',');
    await psql(`update schedules set enabled = true, disabled_reason = null where id in (${list})`).catch(() => undefined);
  }
  // C9's own upgrade leaves the stack up through the BASE compose file, which
  // drops the dev override's ops-port publication. Bring the dev stack back
  // BEFORE the runner so the next run starts where this one did.
  await compose('up', '-d', '--wait').catch(() => undefined);
  await waitForStackReady(300_000).catch(() => undefined);
  // Leave the lane enabled: the next consecutive run starts from a runner that
  // is up and polling (the plan's closing condition).
  await ensureRunnerUp().catch(() => undefined);
  const health = await healthNow().catch(() => null);
  console.log(`MEASURED teardown: runner=${JSON.stringify(health?.runner ?? null)} ` +
    `pin=${JSON.stringify(health?.pin ?? null)}`);
}, 1_200_000);

test('slice5 e2e tests are not silently skipped', () => {
  if (dockerAvailable) return;
  if (process.env[SKIP_SLICE5_E2E_ENV] === '1') return;
  throw new Error(
    'docker compose is not usable, so the slice5 e2e suite was skipped rather than run. '
      + 'Install/start Docker, then rerun:\n\n'
      + '  bun test --parallel=1 test/e2e/slice5.e2e.test.ts\n\n'
      + `If skipping is genuinely intended for this run, set ${SKIP_SLICE5_E2E_ENV}=1 `
      + 'to acknowledge it explicitly.',
  );
});

// C1 — `/metrics` is not a public surface (Task 8's finding, U1; route closed
// in compose/Caddyfile). Kept as it was written.
test('C1: /metrics does not answer an unauthenticated public request', async () => {
  const res = await fetch(`${BASE}/metrics`, { tls: { rejectUnauthorized: false } });
  console.log(`MEASURED public /metrics: ${res.status}`);
  expect([401, 403, 404]).toContain(res.status);
});

/**
 * C2 — the operator's first screen, and the search-mode honesty rule (D7).
 *
 * The walk's first step is a fresh operator: create the first admin, complete
 * the wizard, pick a search mode. On this stack an admin already exists (the
 * clean stack Task 14 left), so the FRESH half is exercised at its real
 * surface — `POST /api/bootstrap` must refuse a second first-admin, and
 * `GET /api/bootstrap` must say the box is claimed. The wizard half is
 * exercised by reading the state the mode screen renders from, and D7 is
 * asserted there: every mode carries upstream's DECLARED relativeCost and OUR
 * measuredCost, which is a number this deployment measured or `null`; upstream's
 * 25x is never presented as ours. The live brain's chosen mode must be one the
 * pinned binary accepts — `conservative | balanced | tokenmax` (F21).
 */
test('C2: the operator door, the wizard state, and the search-mode honesty rule', async () => {
  const boot = await readJson<{ bootstrapped: boolean }>(
    await fetchInsecure('/api/bootstrap'), 'GET /api/bootstrap');
  console.log(`MEASURED C2 bootstrap: bootstrapped=${boot.bootstrapped}`);
  expect(boot.bootstrapped).toBe(true);

  const second = await fetchInsecure('/api/bootstrap', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'second-first-admin@example.test', password: 'a-long-enough-password', orgName: 'Second' }),
  });
  expect(second.status).toBe(409);
  expect((await readJson<{ error: string }>(second, 'second bootstrap')).error).toBe('already_bootstrapped');

  const state = await readJson<{
    lifecycle: string;
    searchMode: string | null;
    searchModes: Array<{ id: string; relativeCost: number; measuredCost: number | null; measuredAt: string | null }>;
  }>(await fetchInsecure('/api/wizard/state', { headers: { cookie: adminCookie } }), 'GET wizard state');

  const ids = state.searchModes.map((m) => m.id);
  console.log(`MEASURED C2 wizard lifecycle=${state.lifecycle} searchMode=${state.searchMode} modes=${ids.join(',')}`);
  expect(ids.sort()).toEqual(['balanced', 'conservative', 'tokenmax']);
  for (const m of state.searchModes) {
    // D7's two numbers, held apart: upstream's claim is always a number; ours
    // is a measured number or null, and a null is "not measured", never 0.
    expect(typeof m.relativeCost).toBe('number');
    if (m.measuredCost !== null) {
      expect(typeof m.measuredCost).toBe('number');
      expect(m.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } else {
      expect(m.measuredAt).toBeNull();
    }
    expect(m.relativeCost === m.measuredCost && m.measuredCost !== null && m.measuredAt === null).toBe(false);
  }
  // The mode the screen shows as selected must be one the pinned binary accepts.
  expect(state.searchMode).not.toBeNull();
  expect(ids).toContain(state.searchMode as string);
}, 180_000);

/**
 * C3 — invite a member, have them claim their Connection, and assert the
 * Space-as-source fence holds.
 *
 * The member writes `internal` and reads only `internal`. The fence is proven
 * on the member's own OAuth client: `whoami` reports the compiled source, and a
 * search for a term that lives in another Space returns nothing outside the
 * grant. Creating the Connection and minting the claim link are the two admin
 * routes; claiming is the member's unauthenticated route with the right email.
 */
test('C3: invite a member, claim the Connection, and the Space-as-source fence holds', async () => {
  const spaces = JSON.parse(await psql(
    "select coalesce(json_agg(json_build_object('id',id,'sourceId',source_id)),'[]'::json) from spaces",
  )) as Array<{ id: string; sourceId: string }>;
  const internal = spaces.find((s) => s.sourceId === 'internal');
  if (!internal) throw new Error('this stack has no `internal` Space to fence on');

  const invited = await scheduledPost('/api/members', { email: WALK_MEMBER_EMAIL, role: 'member' }, adminCookie);
  expect(invited.status).toBe(200);
  const member = await readJson<{ id: string }>(invited, 'POST /api/members');

  const created = await scheduledPost('/api/connections', {
    membershipId: member.id, writeSpaceId: internal.id, readSpaceIds: [internal.id], harness: 'generic',
  }, adminCookie);
  expect(created.status).toBe(200);
  const conn = await readJson<ConnectionRow>(created, 'POST /api/connections');
  expect(conn.state).toBe('pending');
  expect(conn.compiled?.sourceId).toBe('internal');
  expect(conn.compiled?.federatedRead ?? []).toEqual([]);
  walkConnectionId = conn.id;
  walkWriteSource = 'internal';

  const minted = await scheduledPost(`/api/members/${member.id}/claim-link`, {}, adminCookie);
  expect(minted.status).toBe(200);
  const { token } = await readJson<{ token: string }>(minted, 'POST claim-link');

  const claimedRes = await fetchInsecure(`/api/claim/${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: WALK_MEMBER_EMAIL }),
  });
  expect(claimedRes.status).toBe(200);
  const claimed = await readJson<{ membershipId: string; connections: ClaimConnection[] }>(claimedRes, 'claim');
  expect(claimed.membershipId).toBe(member.id);
  const cred = claimed.connections.find((c) => c.connectionId === conn.id);
  expect(cred).toBeTruthy();
  expect(cred!.credentials?.client_id).toBeTruthy();
  expect(cred!.credentials?.client_secret).toBeTruthy();

  // The claim makes the Connection live: the console's own surface says so.
  const live = await waitFor('the Connection to become active', 60_000, async () => {
    const row = (await listConnections(adminCookie)).find((c) => c.id === conn.id);
    return row?.state === 'active' ? row : null;
  });
  expect(live.state).toBe('active');

  // The fence, on the member's own client. The `internal` Space holds a
  // performance-review page; `shared`/`customers` hold others. A search for a
  // term that exists elsewhere must never surface another Space.
  await pointLocalhostAtCaddy();
  const home = `/srv/gbrain-home/walk-${RUN_ID}`;
  await initThinClient(home, cred!);
  const whoArgv = buildArgv(OPERATIONS.whoami!, {}, { json: true });
  const whoRaw = await composeExecEnv('gbrain-ops', ['gbrain', ...whoArgv], { GBRAIN_HOME: home, NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  expect(whoRaw.exitCode).toBe(0);
  const whoBody = parseLastJson(whoRaw.stdout) as {
    transport?: string; source_id?: string; federated_read?: string[];
  };
  expect(whoBody.transport).toBe('oauth');
  expect(whoBody.source_id).toBe('internal');
  console.log(`MEASURED C3 whoami transport=${whoBody.transport} source=${whoBody.source_id} `
    + `federated=${JSON.stringify(whoBody.federated_read ?? [])}`);

  const searchArgv = buildArgv(OPERATIONS.search!, { query: 'Acme wants faster onboarding', limit: '20' }, { json: true });
  const searchRaw = await composeExecEnv('gbrain-ops', ['gbrain', ...searchArgv], { GBRAIN_HOME: home, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 120_000);
  expect(searchRaw.exitCode).toBe(0);
  const hits = searchHits(parseLastJson(searchRaw.stdout));
  const sources = [...new Set(hitSourceIds(hits))].sort();
  console.log(`MEASURED C3 fence search sources=[${sources.join(',')}] over ${hits.length} hit(s)`);
  expect(sources.every((s) => s === 'internal')).toBe(true);
  expect(sources).not.toContain('customers');
  expect(sources).not.toContain('shared');
}, 900_000);

/**
 * C4 — a `gbrain_command` schedule materializes and runs, and its report is
 * read from the Space it committed to.
 *
 * Created through the published route on the walk's Connection, run through
 * `run-now`, and read from the schedule's own runs route. A missing report is a
 * failure, never a skipped check.
 */
test('C4: a gbrain_command schedule runs and its report lands', async () => {
  const name = `walk-cmd-${RUN_ID}`;
  const created = await scheduledPost('/api/schedules', {
    name, connectionId: walkConnectionId, jobType: 'gbrain_command',
    operation: 'sync', kind: 'interval', intervalSeconds: 3600, params: {},
  }, adminCookie);
  expect(created.status).toBe(201);
  const body = await readJson<{ id: string; jobType: string }>(created, 'POST command schedule');
  expect(body.jobType).toBe('gbrain_command');
  WALK_SCHEDULES.push(body.id);

  const started = await scheduledPost(`/api/schedules/${body.id}/run-now`, {}, adminCookie);
  expect(started.status).toBe(202);
  const run = await waitForRunState(body.id, TERMINAL, 600_000, adminCookie);
  expect(run.state).toBe('succeeded');
  expect(run.classification).toBe('ok');
  expect(run.exitCode).toBe(0);
  expect(run.reportPath).toBeTruthy();
  expect(run.summary?.status).toBeTruthy();

  const cat = await opsExec(['cat', `/srv/brain-repos/${walkWriteSource}/${run.reportPath}`]);
  expect(cat.exitCode).toBe(0);
  expect(cat.stdout).toContain(`gbrain sync --source ${walkWriteSource}`);
  expect(cat.stdout).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
  console.log(`MEASURED C4 command run ${run.id} state=${run.state} report=${run.reportPath} `
    + `summary.status=${run.summary?.status}`);
}, 600_000);

/**
 * C5 — the runner lane's real run, and honesty rule 11: prompt, tool calls,
 * tokens, cost and the brain diff in ONE response.
 *
 * The schedule is created through the published route (the runner is up and
 * polling, so the create gate lets a priced agent schedule through), then the
 * REAL container claims it and runs the REAL harness against the REAL brain.
 * The gate never runs the harness itself.
 */
test('C5: an agent_prompt run completes and /api/runs/:id carries the whole receipt', async () => {
  await ensureRunnerUp();
  const slug = `walk/${RUN_ID}/agent`;
  const prompt =
    `Use the mcp__gbrain__put_page tool to write the page "${slug}" with the content `
    + `"GA walk ${RUN_ID}". Then reply with exactly: done`;
  const name = `walk-agent-${RUN_ID}`;
  const created = await scheduledPost('/api/schedules', {
    name, connectionId: walkConnectionId, jobType: 'agent_prompt', kind: 'interval',
    intervalSeconds: 3600, agentPrompt: prompt, agentModel: 'claude-haiku-4-5',
    agentMaxTokens: 512, agentBudgetUsd: '0.20',
  }, adminCookie);
  expect(created.status).toBe(201);
  const body = await readJson<{ id: string; jobType: string }>(created, 'POST agent schedule');
  expect(body.jobType).toBe('agent_prompt');
  WALK_SCHEDULES.push(body.id);

  const started = await scheduledPost(`/api/schedules/${body.id}/run-now`, {}, adminCookie);
  expect(started.status).toBe(202);

  const run = await waitForRunState(body.id, TERMINAL, 900_000, adminCookie);
  if (run.state !== 'succeeded') {
    const d = await readJsonQuiet<Record<string, unknown>>(
      await fetchInsecure(`/api/runs/${run.id}`, { headers: { cookie: adminCookie } }), 'failed run detail');
    const usage = (d.usage ?? []) as Array<{ httpStatus: number | null; stopReason: string | null }>;
    console.log(`MEASURED C5 FAILURE run=${run.id} state=${run.state} class=${run.classification} `
      + `failureClass=${String(d.failureClass)} detail=${JSON.stringify(d.failureDetail).slice(0, 300)} `
      + `http=${JSON.stringify(usage.map((u) => u.httpStatus))} stop=${JSON.stringify(usage.map((u) => u.stopReason))}`);
  }
  expect(run.state).toBe('succeeded');
  expect(run.classification).toBe('ok');
  c5RunId = run.id;

  const res = await fetchInsecure(`/api/runs/${run.id}`, { headers: { cookie: adminCookie } });
  expect(res.status).toBe(200);
  const detail = await readJsonQuiet<Record<string, unknown>>(res, 'run detail');
  expect(detail.runId).toBe(run.id);
  expect(detail.prompt).toBe(prompt);

  const events = detail.events as Array<{ seq: number; kind: string; data: unknown }>;
  const uses: string[] = [];
  for (const e of events) {
    const content = (e.data as { message?: { content?: unknown } } | null)?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; name?: unknown };
      if (b?.type === 'tool_use' && typeof b.name === 'string') uses.push(b.name);
    }
  }
  expect(uses).toContain('mcp__gbrain__put_page');

  const usage = detail.usage as Array<{
    inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: string;
  }>;
  expect(usage.length).toBeGreaterThanOrEqual(1);
  expect(usage.reduce((n, u) => n + u.outputTokens, 0)).toBeGreaterThan(0);
  expect(usage.reduce((n, u) => n + u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens, 0)).toBeGreaterThan(0);
  expect(typeof detail.costUsd).toBe('string');
  expect(Number(detail.costUsd)).toBeGreaterThan(0);

  const diff = detail.diff as { write: { sourceId: string; files: Array<{ path: string }> } };
  expect(diff.write.sourceId).toBe(walkWriteSource);
  expect(diff.write.files.map((f) => f.path)).toContain(`${slug}.md`);

  console.log(`MEASURED C5 run=${run.id} state=${run.state} cost=$${detail.costUsd} `
    + `toolUses=[${uses.join(',')}] usageRows=${usage.length} `
    + `diff=[${diff.write.files.map((f) => f.path).join(',')}]`);
}, 1_200_000);

/**
 * C6 — `/spend` states its own coverage first.
 *
 * Four assertions: our total and gbrain's ledger total are two separate
 * figures; the coverage list matches upstream's `notCovered` strings verbatim,
 * compared against the live ledger read through the same ops lane the page
 * uses; the member whose C5 run produced spend appears with a non-null cost;
 * and the unpriced count is shown even when zero.
 */
test('C6: /api/spend keeps the two totals apart and carries upstream coverage verbatim', async () => {
  const report = await readJson<{
    windowDays: number;
    ours: { totalUsd: number | null; unpricedRuns: number;
            byMember: Array<{ key: string; label: string; runs: number; costUsd: number | null; unpricedRuns: number }> };
    brain: { totals: { costUsd: number }; coverage: { notCovered: string[] } } | null;
    coverage: { ours: string[]; brainReachable: boolean };
  }>(await fetchInsecure('/api/spend?days=30', { headers: { cookie: adminCookie } }), 'GET /api/spend');

  expect(report.windowDays).toBe(30);
  expect(report.coverage.ours.length).toBeGreaterThan(0);

  // The two totals are separate figures, never added: ours and brain's are
  // different shapes, and the report carries no combined total.
  expect(report.ours).toHaveProperty('totalUsd');
  if (report.brain) {
    expect(report.brain.totals).toHaveProperty('costUsd');
    expect(Object.keys(report.ours)).not.toContain('combinedWithBrain');
  }

  // Upstream's exclusions, verbatim, from the live ledger the page reads.
  const live = await brainUsage(30);
  expect(report.brain).not.toBeNull();
  expect(report.brain!.coverage.notCovered).toEqual(live.coverage.notCovered);
  console.log(`MEASURED C6 coverage notCovered=[${live.coverage.notCovered.join(' | ')}]`);

  // The member whose C5 run produced spend.
  const mine = report.ours.byMember.find((m) => m.label === c5MemberEmail || m.key === c5MemberEmail);
  expect(mine).toBeTruthy();
  expect(mine!.costUsd).not.toBeNull();
  expect(mine!.costUsd!).toBeGreaterThan(0);

  // The unpriced count is shown, and it is a count (0 is a valid answer).
  expect(typeof report.ours.unpricedRuns).toBe('number');
  expect(report.ours.unpricedRuns).toBeGreaterThanOrEqual(0);

  console.log(`MEASURED C6 ours=$${report.ours.totalUsd} unpriced=${report.ours.unpricedRuns} `
    + `brainReachable=${report.coverage.brainReachable} member=${mine!.label} memberCost=$${mine!.costUsd}`);

  // C10's number, measured HERE: C9's rollback runs after this and can restore a
  // control-DB snapshot that never saw the walk.
  c10Spend = await measureWalkSpend();
}, 180_000);

// C7 — a backup on the running stack proves its own quiesce. `quiesced` is the
// three-state honesty field (D6): on the dev stack the ops port is published,
// so the lane is `http`; on a production-shaped stack it is `relay`. Either
// way it must be verified and NAME the lane that proved it, never merely truthy.
test('C7: a backup verifies its quiesce and names the lane', async () => {
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
test('C8: restore to a new domain invalidates every Connection, and the console says so', async () => {
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
  adminCookie = cookieAfter;
  const after = await listConnections(cookieAfter);
  const stillActive = after.filter((c) => c.state === 'active');
  console.log(
    `MEASURED C8 domainChanged=${report.domainChanged} `
      + `needingReissue=${report.connectionsNeedingReissue.length} `
      + `activeAfter=${stillActive.length} total=${after.length}`,
  );

  // "rather than showing a working Connection that is not": zero active.
  expect(stillActive.map((c) => c.clientName)).toEqual([]);
}, 1_800_000);

/**
 * C9 — the upgrade lane, re-proved on the renamed, re-published stack.
 *
 * Slice 3.5's exit gate ran 0.50.0.0 -> 0.50.5.0 and rolled a deliberately
 * failed migration back. The rename touched volume names and image references,
 * which is exactly what a rollback depends on, so this leg runs that gate's own
 * path once more: normalize to FROM_PIN, apply the migration-collision fixture
 * so upstream's migration genuinely fails, roll back and assert the restored
 * state is EXACTLY the pre-upgrade state, then run the real upgrade and assert
 * `playbook_ledger` records it and doctor parity holds.
 */
test('C9: an upgrade records in playbook_ledger, a failed migration rolls back exactly, and the real run holds parity', async () => {
  // --- normalize to FROM_PIN (the product's own rollback, else host-side) ----
  const before = await declaredPin();
  if (before !== FROM_PIN) {
    const runId = await latestCompletedRunFromPin(FROM_PIN);
    if (runId) {
      const rb = await upgradeCli(['rollback', '--run', runId]);
      await waitForStackReady(900_000);
      if (rb.exitCode !== 0 && rb.exitCode !== 4) {
        throw new Error(`precondition rollback of ${runId} exited ${rb.exitCode}: ${rb.stderr.slice(0, 300)}`);
      }
      console.log(`MEASURED C9 precondition: rolled back completed run ${runId} to ${FROM_PIN} (exit ${rb.exitCode})`);
    } else {
      await writePin('.env', FROM_PIN);
      const build = await compose('build', '--build-arg', `GBRAIN_VERSION=${FROM_PIN}`, 'gbrain-ops');
      if (build.exitCode !== 0) throw new Error(`precondition build failed: ${build.stderr.slice(0, 300)}`);
      const up = await compose('up', '-d', '--force-recreate', '--wait',
        'gbrain-ops', 'gbrain-serve', 'gbrain-worker', 'control-plane');
      if (up.exitCode !== 0) throw new Error(`precondition recreate failed: ${up.stderr.slice(0, 300)}`);
      await waitForStackReady(900_000);
      console.log(`MEASURED C9 precondition: host-side pin move to ${FROM_PIN}`);
    }
  }
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  // The upgrade window disables writers; restore the set afterwards.
  disabledScheduleIds = (await psql('select id from schedules where enabled'))
    .split('\n').map((s) => s.trim()).filter(Boolean);
  if (disabledScheduleIds.length > 0) {
    await psql("update schedules set enabled = false, disabled_reason = 'gate C upgrade window' where enabled");
  }
  console.log(`MEASURED C9 pending cleared(before fixture): ${await clearPendingDecisions()}`);
  console.log(`MEASURED C9 repo drift cleared: ${JSON.stringify(await clearRepoDrift())}`);

  // --- apply the fixture and snapshot the pre-upgrade state ------------------
  const applied = await applyMigrationCollisionFixture(gbrainPsql);
  fixtureApplied = true;
  expect(applied.recordedSchemaVersionBefore).toBe(PRISTINE_SCHEMA_VERSION);
  expect(applied.recordedSchemaVersionAfter).toBe(FIXTURE_SCHEMA_VERSION);
  preDigest = await stateDigestHost(FROM_PIN, TARGET_PIN);
  console.log(`MEASURED C9 fixture: ${applied.summary}; pre-digest taken`);

  // --- the deliberately failed migration, and the one-click rollback ---------
  const failed = await upgradeCli(['run', '--to', TARGET_PIN, '--yes']);
  expect(failed.exitCode).not.toBe(0);
  if (failed.stdout.indexOf('{') < 0) {
    console.log(`MEASURED C9 failed-run exit=${failed.exitCode}`);
    console.log(`MEASURED C9 failed-run stderr=${failed.stderr.trim().replace(/\s+/g, ' ').slice(0, 700)}`);
    console.log(`MEASURED C9 failed-run stdout=${failed.stdout.trim().replace(/\s+/g, ' ').slice(0, 700)}`);
  }
  const failedRunId = String(cliJson(failed).runId);
  const states = (await journalFor(failedRunId)).map((e) => e.step);
  expect(states).toContain('rolling_back');
  expect(states).not.toContain('completed');
  console.log(`MEASURED C9 failed run ${failedRunId} exit=${failed.exitCode} states=[${states.join(',')}]`);

  const rb = await upgradeCli(['rollback', '--run', failedRunId]);
  expect(rb.exitCode).toBe(0);
  await waitForStackReady(900_000);
  const diff = compareDigests(preDigest, await stateDigestHost(FROM_PIN, TARGET_PIN));
  expect(diff.differing).toEqual([]);
  expect(diff.onlyInA).toEqual([]);
  expect(diff.onlyInB).toEqual([]);
  expect(diff.equal).toBe(true);
  console.log(`MEASURED C9 rollback of ${failedRunId} restored the pre-upgrade state exactly`);

  // --- un-fixture, then the real upgrade --------------------------------------
  const undone = await undoMigrationCollisionFixture(gbrainPsql);
  fixtureApplied = false;
  expect(undone.recordedSchemaVersionAfter).toBe(PRISTINE_SCHEMA_VERSION);
  expect(await columnsOf(gbrainPsql, COLLIDING_OBJECT)).toContain('source_id');
  console.log(`MEASURED C9 un-fixture: ${undone.summary}`);
  console.log(`MEASURED C9 pending cleared(before real run): ${await clearPendingDecisions()}`);
  console.log(`MEASURED C9 repo drift cleared(before real run): ${JSON.stringify(await clearRepoDrift())}`);

  const real = await upgradeCli(['run', '--to', TARGET_PIN, '--yes']);
  expect(real.exitCode).toBe(0);
  const realRunId = String(cliJson(real).runId);
  await waitForStackReady(900_000);

  const ledger = await ledgerRows();
  const row = ledger.find((l) => l.gbrainVersion === TARGET_PIN);
  expect(row).toBeTruthy();
  const gate = await journalEvent(realRunId, 'gate');
  expect(gate).toBeTruthy();
  const parity = (gate!.data as { parity: { regressed: unknown[]; schemaVersionOk: boolean } }).parity;
  expect(parity.regressed).toEqual([]);
  expect(parity.schemaVersionOk).toBe(true);
  const pin = (await healthNow()).pin;
  expect(pin.observed).toBe(TARGET_PIN);
  expect(pin.matches).toBe(true);
  console.log(`MEASURED C9 real run ${realRunId} ledger[${TARGET_PIN}]=${row!.state} `
    + `parity.regressed=[] schemaVersionOk=true observed=${pin.observed}`);
}, 3_600_000);

// C10's teardown is the file-level `afterAll` above: it prints the walk's total
// model spend before deleting the walk's schedules.
