import './host-ops-env.ts';
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunClaim } from '../../src/agent/types.ts';
import { RUN_CLAIM_WAIT_MS } from '../../src/agent/claim.ts';
import { HARNESS_PIN } from '../../src/runner/pin.ts';
import { mintGatewayToken, verifyGatewayToken } from '../../src/gateway/token.ts';
import {
  MODEL_PRICING, priceUsage, usageCounts, type AnthropicUsage,
} from '../../src/gateway/pricing.ts';
import { runnerStateLabel, runnerStateTone } from '../../src/console/pages/Runs.tsx';

/**
 * Slice 4 Gate B — the agent runner lane, end to end, over HTTP (B1–B12).
 *
 * Gate A (Task 15) proves the seam's argv and pure functions headless. This gate
 * proves what Gate A structurally cannot: that a REAL runner claims a REAL row
 * through the shipped routes, that the lease/heartbeat/finish/event vocabulary
 * behaves the way `src/agent/claim.ts` says it does, that the model gateway
 * refuses what it must and meters what it forwards, and that the run-detail
 * projection leaks neither token.
 *
 * Three shape decisions, each made by reading the shipped surface rather than
 * the plan's sample:
 *
 *   1. **The lane is driven from the host.** The runner addresses the control
 *      plane on `runner-net` (`claim.gateway.url` is
 *      `http://control-plane:3150/api/gateway`), but Caddy's `handle /api/*`
 *      proxies the same surface at `${BASE}/api/*`, so every request below is the
 *      route the runner calls, one hop out — and the gateway is driven with the
 *      token the CLAIM handed back, which is the real end-to-end path.
 *   2. **B1 lets the real container claim.** The genuine `agent-runner`
 *      container takes the occurrence, so `claimed_by` is the id that container
 *      announced on its own stdout (`${HOSTNAME}-${uuid8}`, D1). Its claim is
 *      ended by the pin handshake (`harness_pin_mismatch`, D4) rather than run:
 *      the refusal happens after `claimed_by` is written and before the gbrain
 *      client is minted, so the leg spends no money and touches no Space, and a
 *      full real harness run stays Gate C's job.
 *   3. **The gate's own claim drives B2–B8.** An agent claim consumes a pending
 *      `schedule_runs` row, and the create route correctly refuses an
 *      `agent_prompt` schedule while no claim is live (honesty rule 8 — asserted
 *      live in B11's control), so the ONLY way to a first pending occurrence is
 *      to write the fixture schedule row. One fixture is inserted through
 *      `psql`; everything after it is a published route, and every leg asserts on
 *      the row.
 *
 * `docs/slice-4-findings.md` F14 is why B10 asserts on health after its
 * recreate instead of assuming: a recreated control plane is a new address, and a
 * runner long-polling the old one reports `Unable to connect` forever while the
 * lane is up.
 *
 * The waits in this file are real wall-clock waits because the things being
 * awaited are the STACK's own clocks — a 25s long poll, a 15s scheduler tick, a
 * container recreate. No fake timer can advance another process's clock.
 */

const SKIP_SLICE4_E2E_ENV = 'BRAINSTAND_ALLOW_SKIP_SLICE4_E2E';

const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8443';
const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PASSWORD = 'a-long-enough-password';
const VIEWER_EMAIL = 'gate-b-viewer@example.test';
const VIEWER_PASSWORD = 'a-long-enough-password';
const RUN_ID = Date.now().toString(36);

// L2: defaulted inside the file, never a required export. Nothing here opens the
// control DB directly — the live one is reached through its container — but the
// contract modules this gate imports bind a DSN, and a missing one must not be a
// required export.
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

/**
 * The host directory the control-plane bind-mounts read-only at /srv/upgrades.
 * Mirrors `slice35.e2e.test.ts` exactly, and on purpose: on this Windows dev
 * host the production default does not exist, and recreating control-plane with
 * a different bind SOURCE would move the upgrade journal out from under Gate C.
 * Same default, same directory, no drift.
 */
const HOST_UPGRADE_DIR = process.env.UPGRADE_DIR ?? join(tmpdir(), 'brainstand-upgrade-e2e');
process.env.UPGRADE_DIR = HOST_UPGRADE_DIR;

const COMPOSE_ENV: Record<string, string> = {
  ...process.env as Record<string, string>,
  DOMAIN: process.env.DOMAIN ?? 'localhost',
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? 'change-me-in-a-real-deployment',
  OPS_RPC_TOKEN: process.env.OPS_RPC_TOKEN ?? 'compose-exec-placeholder',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? 'compose-exec-placeholder-32-characters',
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'compose-exec-placeholder-32-characters',
};

// `.env` is the single source of the pin for every compose call (see
// slice35.e2e.test.ts for the measured defect an ambient GBRAIN_VERSION caused).
delete COMPOSE_ENV.GBRAIN_VERSION;

const COMPOSE = [
  'docker', 'compose',
  ...(existsSync('.env') ? ['--env-file', '.env'] as const : []),
  '-f', 'compose/docker-compose.yml',
  '-f', 'compose/docker-compose.dev.yml',
];

const fetchInsecure = (path: string, init?: RequestInit) =>
  fetch(`${BASE}${path}`, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);

/**
 * Compose with an env override — how B10 hands the control plane an EMPTY
 * `RUNNER_TOKEN` for one recreate without editing a file. Compose precedence
 * puts the child process env above `.env`, and the service's own
 * `RUNNER_TOKEN: ${RUNNER_TOKEN:-}` is what carries it in (D12).
 */
function composeWith(overrides: Record<string, string>, ...args: string[]) {
  return composeArgs({ ...COMPOSE_ENV, ...overrides }, ...args);
}

function compose(...args: string[]) {
  return composeArgs(COMPOSE_ENV, ...args);
}

async function composeArgs(env: Record<string, string>, ...args: string[]) {
  const p = Bun.spawn([...COMPOSE, ...args], { stdout: 'pipe', stderr: 'pipe', env });
  const timer = setTimeout(() => p.kill(), 900_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

/** Read a JSON scalar/array out of the LIVE control DB via its container (the
 *  live postgres publishes no host port, so compose exec is the only route). */
async function psql(sql: string): Promise<string> {
  const p = Bun.spawn([...COMPOSE, 'exec', '-T', 'postgres', 'psql', '-U', 'gbrain', '-d', 'control', '-tAc', sql], {
    stdout: 'pipe', stderr: 'pipe', env: COMPOSE_ENV,
  });
  const timer = setTimeout(() => p.kill(), 300_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    if (exitCode !== 0) throw new Error(`psql failed (${exitCode}): ${stderr || stdout}`);
    return stdout.trim();
  } finally { clearTimeout(timer); }
}

/** `psql -tAc` prints one value per row; every scalar read here is the first. */
const one = (v: string): string => v.split(/\r?\n/)[0] ?? '';

async function probeDockerCompose(): Promise<boolean> {
  try {
    return (await Bun.$`docker compose version`.quiet().nothrow()).exitCode === 0;
  } catch {
    return false;
  }
}

const dockerAvailable = await probeDockerCompose();

/** The container id compose is running for a service (empty when none is). */
async function dockerLogs(service: string, tail = 300): Promise<string> {
  const ps = await compose('ps', '-q', service);
  const id = one(ps.stdout.trim());
  if (!id) return '';
  const p = Bun.spawn(['docker', 'logs', '--tail', String(tail), id], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => p.kill(), 60_000);
  try {
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(),
    ]);
    return `${out}\n${err}`;
  } finally { clearTimeout(timer); }
}

/** `[runner] <id> up, harness <v>, tools <n> on the closed list` (src/runner/main.ts). */
async function announcedRunner(): Promise<{ id: string; harnessVersion: string } | null> {
  const matches = [...(await dockerLogs('agent-runner')).matchAll(/\[runner\] (\S+) up, harness (\S+),/g)];
  const last = matches[matches.length - 1];
  return last ? { id: last[1]!, harnessVersion: last[2]! } : null;
}

/** `[scheduler] <WORKER_ID> up, tick <n>ms` (src/scheduler/main.ts). */
async function schedulerWorker(): Promise<string | null> {
  const matches = [...(await dockerLogs('scheduler', 200)).matchAll(/\[scheduler\] (\S+) up, tick/g)];
  return matches[matches.length - 1]?.[1] ?? null;
}

// --- the live control DB's view of the rows every leg asserts on -------------

type ScheduleRunRow = {
  id: string;
  scheduleId: string;
  state: string;
  claimedBy: string | null;
  classification: string | null;
  attempt: number;
  summary: Record<string, unknown> | null;
  leaseExpiresAt: string | null;
  startedAt: string | null;
};

const RUN_ROW_FIELDS =
  "'id',r.id,'scheduleId',r.schedule_id,'state',r.state,'claimedBy',r.claimed_by,"
  + "'classification',r.classification,'attempt',r.attempt,'summary',r.summary,"
  + "'leaseExpiresAt',r.lease_expires_at,'startedAt',r.started_at";

async function runsOf(scheduleId: string): Promise<ScheduleRunRow[]> {
  return JSON.parse(await psql(
    `select coalesce(json_agg(json_build_object(${RUN_ROW_FIELDS}) order by r.created_at), '[]'::json) `
    + `from schedule_runs r where r.schedule_id = '${scheduleId}'`,
  )) as ScheduleRunRow[];
}

async function runRow(runId: string): Promise<ScheduleRunRow | null> {
  const rows = JSON.parse(await psql(
    `select coalesce(json_agg(json_build_object(${RUN_ROW_FIELDS})), '[]'::json) `
    + `from schedule_runs r where r.id = '${runId}'`,
  )) as ScheduleRunRow[];
  return rows[0] ?? null;
}

type AgentRunRow = {
  costUsd: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
  budgetUsd: string;
  failureClass: string | null;
  tokenRevokedAt: string | null;
  gbrainClientId: string | null;
  numTurns: number;
};

async function agentRun(runId: string): Promise<AgentRunRow | null> {
  const rows = JSON.parse(await psql(
    "select coalesce(json_agg(json_build_object("
    + "'costUsd',a.cost_usd,'inputTokens',a.input_tokens,'outputTokens',a.output_tokens,"
    + "'cacheReadTokens',a.cache_read_tokens,'cacheWriteTokens',a.cache_write_tokens,"
    + "'model',a.model,'budgetUsd',a.budget_usd,'failureClass',a.failure_class,"
    + "'tokenRevokedAt',a.token_revoked_at,'gbrainClientId',a.gbrain_client_id,"
    + "'numTurns',a.num_turns)), '[]'::json) "
    + `from agent_runs a where a.run_id = '${runId}'`,
  )) as AgentRunRow[];
  return rows[0] ?? null;
}

type UsageRow = {
  seq: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: string | null;
  stopReason: string | null;
  httpStatus: number | null;
};

async function usageRows(runId: string): Promise<UsageRow[]> {
  return JSON.parse(await psql(
    "select coalesce(json_agg(json_build_object("
    + "'seq',u.seq,'model',u.model,'inputTokens',u.input_tokens,'outputTokens',u.output_tokens,"
    + "'cacheReadTokens',u.cache_read_tokens,'cacheWriteTokens',u.cache_write_tokens,"
    + "'costUsd',u.cost_usd,'stopReason',u.stop_reason,'httpStatus',u.http_status"
    + ") order by u.seq), '[]'::json) "
    + `from agent_run_usage u where u.run_id = '${runId}'`,
  )) as UsageRow[];
}

async function eventRows(runId: string): Promise<Array<{ seq: number; kind: string; data: unknown }>> {
  return JSON.parse(await psql(
    "select coalesce(json_agg(json_build_object('seq',e.seq,'kind',e.kind,'data',e.data) "
    + "order by e.seq), '[]'::json) "
    + `from agent_run_events e where e.run_id = '${runId}'`,
  )) as Array<{ seq: number; kind: string; data: unknown }>;
}

/** Every metered call in the stack, so B5 can prove nothing moved while it made
 *  no upstream call. */
async function totalRecordedSpend(): Promise<string> {
  return one(await psql("select coalesce(sum(cost_usd::numeric), 0)::text from agent_run_usage"));
}

// --- HTTP surfaces -----------------------------------------------------------

/** L4/L10: BOTH surfaces behind the one proxy. A measured window existed where
 *  console health answered 200 while the reserved path answered 502. */
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

type Health = {
  ok: boolean;
  components: Record<string, string>;
  pin: { declared: string; observed: string | null; matches: boolean | null };
  runner: { state: string; lastSeenAt: string | null; version: string | null };
  scheduleAlerts: Array<{ id: string; kind: string }>;
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
    } catch { /* the recreate window: Caddy answers 502 while the container restarts */ }
    await Bun.sleep(2_000);
  }
  throw new Error(
    `${label}: /api/health never said so within ${timeoutMs}ms (last runner=`
    + `${JSON.stringify(last?.runner ?? null)} components=${JSON.stringify(last?.components ?? null)})`,
  );
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

/**
 * The same reader for the two responses that carry — or might carry — a
 * credential: `POST /api/runs/claim` hands back both per-run tokens, and the run
 * detail is the projection whose whole job is not to. A failure here must never
 * paste the body into the test output; a gate that leaks a live token to prove
 * it did not leak a live token is the bug this file exists to catch.
 */
async function readJsonQuiet<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`${label}: ${res.status} unparseable; the body is withheld on purpose`); }
}

// --- the runner lane's two credentials ---------------------------------------

/** `RUNNER_TOKEN` — the bearer half of D1. Read per call, never printed. */
function runnerToken(): string {
  const token = (process.env.RUNNER_TOKEN ?? '').trim();
  if (!token) {
    throw new Error(
      'RUNNER_TOKEN is not set in this process environment. The repo-root `.env` supplies it '
        + '(Bun loads it); without it the lane is disabled and this gate cannot run.',
    );
  }
  return token;
}

const runnerHeaders = (extra: Record<string, string> = {}) =>
  ({ 'content-type': 'application/json', authorization: `Bearer ${runnerToken()}`, ...extra });

/** B1's own identity fallback, in D1's `${HOSTNAME}-${uuid8}` shape — so the row
 *  proves the identity and never merely the shape. */
const MY_RUNNER_ID = `gate-b-${randomUUID().slice(0, 8)}`;
const THIEF_ID = `gate-b-thief-${randomUUID().slice(0, 8)}`;
/** The shape BOTH consumers' ids have: the runner's and the scheduler's. */
const RUNNER_ID_RE = /^[A-Za-z0-9_.-]+-[0-9a-f]{8}$/;

function claimAsRunner(runnerId: string, body: Record<string, unknown> = {}) {
  return fetchInsecure('/api/runs/claim', {
    method: 'POST', headers: runnerHeaders(),
    body: JSON.stringify({ runnerId, harnessVersion: HARNESS_PIN, ...body }),
  });
}

function runnerPost(path: string, body: unknown) {
  return fetchInsecure(path, { method: 'POST', headers: runnerHeaders(), body: JSON.stringify(body) });
}

/** The same `POST {mcp}/mcp` the harness makes, and the read that answers "is
 *  this bearer still a credential" (P7: a raw bearer, no handshake). */
function mcpToolsList(token: string) {
  return fetchInsecure('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

// --- fixtures ----------------------------------------------------------------

let adminCookie = '';
let viewerCookie = '';
let fixtureConnectionId = '';
let fixtureOrgId = '';
let fixtureAdminUserId = '';

/**
 * The one fixture this gate writes: an `agent_prompt` schedule row. The create
 * route (correctly) refuses an agent schedule while no claim is live, and a
 * claim needs a pending occurrence to consume — so the FIRST occurrence has to
 * come from a row. Everything after this line is a published route.
 */
async function insertAgentSchedule(args: {
  id: string;
  pin: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  budgetUsd?: string;
  timeoutSeconds?: number;
}): Promise<void> {
  const got = one(await psql(
    'insert into schedules ('
    + 'id, organization_id, connection_id, name, kind, interval_seconds, anchor_at, operation, '
    + 'job_type, agent_prompt, agent_model, agent_max_tokens, agent_budget_usd, '
    + 'agent_harness_version, timeout_seconds, created_by, report_policy, notifies, enabled, params'
    + ') values ('
    + `'${args.id}','${fixtureOrgId}','${fixtureConnectionId}','${args.id}','interval',3600,now(),`
    + `null,'agent_prompt','${args.prompt}','${args.model ?? 'claude-haiku-4-5'}',`
    + `${args.maxTokens ?? 256},'${args.budgetUsd ?? '0.05'}','${args.pin}',`
    + `${args.timeoutSeconds ?? 300},'${fixtureAdminUserId}','never',false,true,'{}'`
    + ') returning id',
  ));
  expect(got).toBe(args.id);
}

/** Delete one fixture schedule: `schedule_runs` → `agent_runs` → its events and
 *  usage all cascade from it, so this is the whole teardown for one fixture. The
 *  alerts go FIRST, so no orphan alert names a run that no longer exists. */
async function deleteScheduleFixture(id: string): Promise<void> {
  await psql(
    `delete from schedule_alerts where run_id in (select id from schedule_runs where schedule_id = '${id}') `
    + `or schedule_id = '${id}'; delete from schedules where id = '${id}'`,
  );
}

function scheduledPost(path: string, body: unknown) {
  return fetchInsecure(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify(body),
  });
}

const AGENT_PAYLOAD = {
  jobType: 'agent_prompt',
  kind: 'interval',
  intervalSeconds: 3600,
  agentPrompt: 'Reply with exactly: ok',
  agentModel: 'claude-haiku-4-5',
  agentMaxTokens: 256,
  agentBudgetUsd: '0.05',
};

// --- state the legs share ----------------------------------------------------

const obs: {
  healthDisabled: Health | null;
  healthRestored: Health | null;
  healthConnected: Health | null;
  b6Marker: string;
} = { healthDisabled: null, healthRestored: null, healthConnected: null, b6Marker: '' };

let claim: AgentRunClaim | null = null;
let runId = '';
let fixtureScheduleId = '';
let commandScheduleId = '';
const FIXTURE_SCHEDULES: string[] = [];
const PROMPT = `gate-b prompt ${RUN_ID}: reply with exactly ok`;
const PIN_MISMATCH = `0.0.0-gate-b-${RUN_ID}`;

function needClaim(): AgentRunClaim {
  if (!claim) throw new Error('the gate did not claim a run: an earlier leg must have failed');
  return claim;
}

// --- beforeAll ---------------------------------------------------------------

beforeAll(async () => {
  if (!dockerAvailable) return;
  await mkdir(HOST_UPGRADE_DIR, { recursive: true });

  let reachable = false;
  try { reachable = (await fetchInsecure('/api/health')).status < 500; } catch { /* cold */ }
  if (!reachable) {
    const up = await compose('up', '-d');
    if (up.exitCode !== 0) throw new Error(`compose up failed: ${up.stderr || up.stdout}`);
  }
  await waitForStackReady(300_000);

  // The lane's own container is RECREATED, not merely started: a recreated
  // control-plane keeps its name but not its address, and a runner that
  // long-polled the old one reports `Unable to connect` forever while health
  // says the lane is configured (measured on this stack, F14's neighbourhood). A
  // fresh container resolves the name again and announces its id on stdout —
  // which is the id B1 then finds in `claimed_by`.
  await compose('stop', 'agent-runner');
  const up = await compose('up', '-d', '--no-deps', '--force-recreate', 'agent-runner');
  if (up.exitCode !== 0) throw new Error(`agent-runner recreate failed: ${up.stderr || up.stdout}`);
  const announced = await waitFor('the runner container to announce itself', 120_000, announcedRunner, 2_000);
  expect(announced.harnessVersion).toBe(HARNESS_PIN);

  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  viewerCookie = await signIn(VIEWER_EMAIL, VIEWER_PASSWORD);

  // A Connection that is ACTIVE and writes a Space nothing else in this stack
  // commits to. `internal` is chosen deliberately: the live 5-minute `live-sync`
  // schedule writes `shared`, and a read Space that moves under a run is an
  // alert (honesty rule 10) this gate should not manufacture.
  const conns = JSON.parse(await psql(
    "select coalesce(json_agg(json_build_object('id',c.id,'organizationId',c.organization_id) "
    + "order by c.id), '[]'::json) from connections c join spaces s on s.id = c.write_space_id "
    + "where c.state = 'active' and s.source_id = 'internal'",
  )) as Array<{ id: string; organizationId: string }>;
  if (conns.length === 0) throw new Error('no active Connection writes the `internal` Space');
  fixtureConnectionId = conns[0]!.id;
  fixtureOrgId = conns[0]!.organizationId;
  fixtureAdminUserId = one(await psql("select id from users where email = 'admin@example.test'"));
  if (!fixtureAdminUserId) throw new Error('the admin user is missing from the live control DB');
}, 900_000);

// NOTE: no `docker compose down -v` anywhere in this file, including the
// teardown. The populated brain is Gate C's expensive fixture (L5/F28): a
// re-provisioned volume is not equivalent to the one the other gates stand on.

describe('Slice 4 agent runner gate B', () => {
  test('slice4 e2e tests are not silently skipped', () => {
    if (dockerAvailable) return;
    if (process.env[SKIP_SLICE4_E2E_ENV] === '1') return;
    throw new Error(
      'docker compose is not usable, so the slice4 e2e suite was skipped rather than run. '
        + 'Install/start Docker, then rerun:\n\n'
        + '  bun test --parallel=1 test/e2e/slice4.e2e.test.ts\n\n'
        + `If skipping is genuinely intended for this run, set ${SKIP_SLICE4_E2E_ENV}=1 `
        + 'to acknowledge it explicitly.',
    );
  });

  /**
   * B10 — the lane with no runner answers `503`/`409`-shaped refusals, and comes
   * back.
   *
   * The create route reads `RUNNER_TOKEN` out of the control plane's own process
   * environment on every call, so this is not mockable and must not be: the lane
   * is taken down for real — the profile's container stopped, and control-plane
   * recreated with an EMPTY `RUNNER_TOKEN`, which is the state a runner-less
   * deployment boots in (D12) — and every refusal is read off the live surface.
   */
  test('B10 a stack with no runner refuses agent work, then comes back', async () => {
    expect((await healthNow()).runner.state).not.toBe('disabled');

    // --- down: the profile's container stopped, an empty RUNNER_TOKEN in -----
    expect((await compose('stop', 'agent-runner')).exitCode).toBe(0);
    const down = await composeWith({ RUNNER_TOKEN: '' }, 'up', '-d', '--force-recreate', 'control-plane');
    expect(down.exitCode).toBe(0);

    obs.healthDisabled = await waitForHealth(
      (h) => h.runner.state === 'disabled', 180_000, 'the lane to report disabled',
    );
    // The env-only reading, which is not a runner waiting for work: no
    // timestamp, no fabricated version.
    expect(obs.healthDisabled.runner)
      .toEqual({ state: 'disabled', lastSeenAt: null, version: null });
    expect(obs.healthDisabled.ok).toBe(true);
    console.log(`[gate-b] B10 health while disabled: ${JSON.stringify(obs.healthDisabled.runner)}`);

    // The runner bearer is refused before any comparison: an empty expected
    // token never authenticates (two empty strings would pass timingSafeEqual).
    const whileDown = await fetchInsecure('/api/runs/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${runnerToken()}` },
      body: JSON.stringify({ runnerId: MY_RUNNER_ID, harnessVersion: HARNESS_PIN }),
    });
    expect(whileDown.status).toBe(503);
    expect(await whileDown.json()).toEqual({ error: 'runner_disabled' });

    // Honesty rule 8 at the create route: no consumer, no schedule.
    const name = `gate-b-no-runner-${RUN_ID}`;
    const refused = await scheduledPost('/api/schedules', {
      ...AGENT_PAYLOAD, connectionId: fixtureConnectionId, name,
    });
    expect(refused.status).toBe(409);
    const refusedBody = await readJson<{ error: string; state: string; lastSeenAt: string | null; detail: string }>(
      refused, 'create while disabled',
    );
    expect(refusedBody.error).toBe('runner_not_enabled');
    expect(refusedBody.state).toBe('disabled');
    expect(refusedBody.lastSeenAt).toBeNull();
    expect(refusedBody.detail.length).toBeGreaterThan(20);
    // A refusal that still wrote a row would be a schedule nobody can run.
    expect(one(await psql(`select count(*) from schedules where name = '${name}'`))).toBe('0');
    console.log(`[gate-b] B10 create while disabled: 409 ${refusedBody.error} (state ${refusedBody.state})`);

    // --- up: the same config, restored, and the lane answers -----------------
    expect((await compose('up', '-d', '--force-recreate', 'control-plane')).exitCode).toBe(0);
    expect((await compose('up', '-d', '--no-deps', 'agent-runner')).exitCode).toBe(0);

    obs.healthRestored = await waitForHealth(
      (h) => h.runner.state !== 'disabled', 180_000, 'the lane to come back',
    );
    // No agent run has been claimed in this gate's own run yet, and the previous
    // run deleted its fixtures, so the honest reading is `never_claimed`.
    expect(obs.healthRestored.runner.state).toBe('never_claimed');
    expect(obs.healthRestored.runner.version).toBeNull();

    // "The lane answers" without spending a 25s poll: a claim with no runner id
    // is refused by the request-shape gate (`runner_never_seen`, 400), which is
    // the route saying it exists and is configured.
    const shape = await fetchInsecure('/api/runs/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${runnerToken()}` },
      body: JSON.stringify({ harnessVersion: HARNESS_PIN }),
    });
    expect(shape.status).toBe(400);
    expect((await readJson<{ error: string }>(shape, 'shape refusal')).error).toBe('runner_never_seen');

    const announced = await waitFor('the runner container to come back', 120_000, announcedRunner, 2_000);
    expect(announced.harnessVersion).toBe(HARNESS_PIN);
    console.log(
      `[gate-b] B10 restored: runner=${JSON.stringify(obs.healthRestored.runner)} `
      + `container=${announced.id} harness=${announced.harnessVersion}`,
    );
  }, 600_000);

  /**
   * B11 — an unpriced model is refused at schedule creation, and the refusal
   * comes BEFORE the runner check.
   *
   * The control pair is the leg: the same body with a priced model reaches the
   * runner gate (409 `runner_not_enabled` — no claim is live in this window),
   * and with an unpriced one it stops at the price table (400 `unpriced_model`).
   * That is what makes the precedence an observation instead of a reading of the
   * source.
   */
  test('B11 an unpriced model is refused at creation, before the runner gate', async () => {
    const unpriced = 'claude-nonesuch-9';
    const name = `gate-b-unpriced-${RUN_ID}`;
    const res = await scheduledPost('/api/schedules', {
      ...AGENT_PAYLOAD, connectionId: fixtureConnectionId, name, agentModel: unpriced,
    });
    expect(res.status).toBe(400);
    const body = await readJson<{ error: string; model: string; pricedAt: string; detail: string }>(
      res, 'unpriced create',
    );
    expect(body.error).toBe('unpriced_model');
    expect(body.model).toBe(unpriced);
    expect(body.pricedAt).toBe(MODEL_PRICING.pricedAt);
    expect(body.detail).toContain('price table');

    const controlName = `gate-b-priced-${RUN_ID}`;
    const control = await scheduledPost('/api/schedules', {
      ...AGENT_PAYLOAD, connectionId: fixtureConnectionId, name: controlName,
    });
    expect(control.status).toBe(409);
    expect((await readJson<{ error: string }>(control, 'priced control')).error).toBe('runner_not_enabled');

    expect(one(await psql(
      `select count(*) from schedules where name in ('${name}', '${controlName}')`,
    ))).toBe('0');
    console.log(
      `[gate-b] B11 unpriced model -> ${res.status} ${body.error} (pricedAt ${body.pricedAt}); `
      + `priced model -> ${control.status} runner_not_enabled`,
    );
  }, 120_000);

  /**
   * B1 — the real runner container claims, and `claimed_by` is the id that
   * container announced, not the scheduler's.
   *
   * The occurrence is a REAL one: `run-now` (a published route) materializes it,
   * and the live container — which is long-polling `/api/runs/claim` — takes it.
   * The fixture pin is deliberately wrong, so the container claims and is then
   * refused by D4's pin handshake. `claimed_by` is already written at that point,
   * the refusal lands before the gbrain client is minted, and the leg therefore
   * costs nothing and touches no Space.
   */
  test('B1 the runner claims, and claimed_by is the runner id', async () => {
    const announced = await announcedRunner();
    expect(announced).not.toBeNull();
    const schedulerId = await schedulerWorker();
    expect(schedulerId).not.toBeNull();

    // Same shape, different identities: the shape is not what this leg proves.
    expect(announced!.id).toMatch(RUNNER_ID_RE);
    expect(schedulerId!).toMatch(RUNNER_ID_RE);
    expect(announced!.id).not.toBe(schedulerId!);

    const scheduleId = `gate-b-pin-${RUN_ID}`;
    FIXTURE_SCHEDULES.push(scheduleId);
    await insertAgentSchedule({ id: scheduleId, pin: PIN_MISMATCH, prompt: PROMPT });
    expect((await scheduledPost(`/api/schedules/${scheduleId}/run-now`, {})).status).toBe(202);

    const claimed = await waitFor('the runner container to claim the run', 120_000, async () => {
      const row = (await runsOf(scheduleId))[0];
      return row?.claimedBy ? row : null;
    }, 2_000);

    expect(claimed.claimedBy).toBe(announced!.id);
    expect(claimed.claimedBy).not.toBe(schedulerId!);
    expect(claimed.claimedBy).not.toBe(MY_RUNNER_ID);
    // The claim is the runner lane's own: the refusal that ends it is D4's pin
    // handshake, which the scheduler's consumer cannot produce.
    expect(claimed.state).toBe('failed');
    expect(claimed.classification).toBe('refused');
    expect(claimed.summary?.error).toBe('harness_pin_mismatch');
    expect(String(claimed.summary?.detail)).toContain(announced!.harnessVersion);
    // No gbrain client, no meter row, no money: the pin is checked before the mint.
    expect(one(await psql(`select count(*) from agent_runs where run_id = '${claimed.id}'`))).toBe('0');
    console.log(
      `[gate-b] B1 claimed_by=${claimed.claimedBy} scheduler=${schedulerId} run=${claimed.id} `
      + `state=${claimed.state} classification=${claimed.classification} `
      + `reason=${String(claimed.summary?.error)}`,
    );
  }, 300_000);

  /**
   * B9 — one queue, two consumers, and neither takes the other's row.
   *
   * Both halves are observed in one window so each is evidence for the other:
   * with the scheduler STOPPED, a pending `gbrain_command` row is refused by the
   * runner lane (204, row still pending — nobody else could have taken it); with
   * the runner's container STOPPED, a pending `agent_prompt` row is left alone
   * across scheduler ticks that the command row itself proves happened.
   */
  test('B9 the scheduler does not claim agent rows and the runner does not claim command rows', async () => {
    expect((await compose('stop', 'agent-runner')).exitCode).toBe(0);
    const schedulerBefore = await schedulerWorker();
    expect(schedulerBefore).not.toBeNull();
    expect((await compose('stop', 'scheduler')).exitCode).toBe(0);

    // (a) a command schedule, created through the published route.
    //     `reportPolicy: never` so the run leaves no report file in the Space.
    commandScheduleId = (await readJson<{ id: string }>(
      await scheduledPost('/api/schedules', {
        name: `gate-b-cmd-${RUN_ID}`,
        connectionId: fixtureConnectionId,
        jobType: 'gbrain_command',
        operation: 'sync',
        kind: 'interval',
        intervalSeconds: 3600,
        reportPolicy: 'never',
      }),
      'command schedule create',
    )).id;
    expect((await scheduledPost(`/api/schedules/${commandScheduleId}/run-now`, {})).status).toBe(202);

    const cmdPending = (await runsOf(commandScheduleId))[0]!;
    expect(cmdPending.state).toBe('pending');
    expect(cmdPending.claimedBy).toBeNull();

    // (b) the runner lane refuses it. Non-vacuous: the scheduler is stopped, so
    //     nobody else can have taken the row while the poll was open.
    const runnerPoll = await claimAsRunner(MY_RUNNER_ID);
    expect(runnerPoll.status).toBe(204);
    expect(await runnerPoll.text()).toBe('');
    const cmdUntouched = (await runsOf(commandScheduleId))[0]!;
    expect(cmdUntouched.id).toBe(cmdPending.id);
    expect(cmdUntouched.state).toBe('pending');
    expect(cmdUntouched.claimedBy).toBeNull();

    // (c) a pending agent_prompt row, and the scheduler back up.
    fixtureScheduleId = `gate-b-agent-${RUN_ID}`;
    FIXTURE_SCHEDULES.push(fixtureScheduleId);
    await insertAgentSchedule({ id: fixtureScheduleId, pin: HARNESS_PIN, prompt: PROMPT });
    expect((await scheduledPost(`/api/schedules/${fixtureScheduleId}/run-now`, {})).status).toBe(202);
    const agentPending = (await runsOf(fixtureScheduleId))[0]!;
    expect(agentPending.state).toBe('pending');
    expect(agentPending.claimedBy).toBeNull();

    expect((await compose('up', '-d', '--no-deps', 'scheduler')).exitCode).toBe(0);
    const schedulerNow = await waitFor('the scheduler to announce a new worker id', 120_000, async () => {
      const id = await schedulerWorker();
      return id && id !== schedulerBefore ? id : null;
    }, 2_000);

    const cmdClaimed = await waitFor('the scheduler to claim the command row', 120_000, async () => {
      const row = (await runsOf(commandScheduleId))[0];
      return row?.claimedBy ? row : null;
    }, 3_000);
    expect(cmdClaimed.claimedBy).toBe(schedulerNow);
    expect(cmdClaimed.claimedBy).not.toBe(MY_RUNNER_ID);

    // (d) the same window, the other lane: the agent row must not move, and the
    //     command row above is the proof that ticks happened.
    const windowEnd = Date.now() + 35_000;
    let checks = 0;
    while (Date.now() < windowEnd) {
      const row = (await runsOf(fixtureScheduleId))[0]!;
      expect(row.state).toBe('pending');
      expect(row.claimedBy).toBeNull();
      checks += 1;
      await Bun.sleep(4_000);
    }
    expect(checks).toBeGreaterThanOrEqual(3);
    console.log(
      `[gate-b] B9 scheduler ${schedulerBefore} -> ${schedulerNow} claimed command run ${cmdClaimed.id}; `
      + `agent run ${agentPending.id} still ${(await runsOf(fixtureScheduleId))[0]!.state}/unclaimed `
      + `after ${checks} checks over 35s`,
    );
  }, 600_000);

  /**
   * The claim B2–B8 and B12 hang off: the gate's own runner identity takes the
   * pending agent row the previous leg left (through the same route the
   * container uses), so a live lease, a run token and a gateway token all exist
   * to assert on.
   */
  test('setup: the gate claims its own run through the real claim route', async () => {
    const res = await claimAsRunner(MY_RUNNER_ID);
    expect(res.status).toBe(200);
    claim = await readJsonQuiet<AgentRunClaim>(res, 'claim');
    runId = claim.runId;
    expect(claim.scheduleId).toBe(fixtureScheduleId);
    expect(claim.model).toBe('claude-haiku-4-5');
    expect(claim.harnessVersion).toBe(HARNESS_PIN);
    expect(claim.budgetUsd).toBe(0.05);
    expect(claim.allowedTools.length).toBeGreaterThan(0);
    // The two per-run credentials, and the proof they ARE credentials: the
    // gateway token verifies against the shipped verifier for THIS run.
    expect(claim.mcp.token.length).toBeGreaterThan(20);
    expect(verifyGatewayToken(claim.gateway.token)?.runId).toBe(runId);
    expect(new Date(claim.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now());

    const row = (await runRow(runId))!;
    expect(row.state).toBe('running');
    expect(row.claimedBy).toBe(MY_RUNNER_ID);
    const stored = (await agentRun(runId))!;
    expect(stored.model).toBe('claude-haiku-4-5');
    expect(stored.costUsd).toBeNull();
    expect(stored.tokenRevokedAt).toBeNull();

    obs.healthConnected = await healthNow();
    expect(obs.healthConnected.runner.state).toBe('connected');
    expect(obs.healthConnected.runner.lastSeenAt).not.toBeNull();
    console.log(
      `[gate-b] setup claim run=${runId} schedule=${claim.scheduleId} model=${claim.model} `
      + `tools=${claim.allowedTools.length} lease=${claim.leaseExpiresAt} `
      + `health.runner=${JSON.stringify(obs.healthConnected.runner)}`,
    );
  }, 180_000);

  /**
   * B2 — an empty long poll answers `204` with an empty body, after roughly
   * `RUN_CLAIM_WAIT_MS`.
   *
   * The route reads the wait per call, so a test COULD lower it. This leg does
   * not: it proves the default the code carries by importing `RUN_CLAIM_WAIT_MS`
   * (25 000ms, deliberately under the common 30s proxy idle timeout) and by
   * holding a real request open against the real route for the real duration. The
   * queue is empty here precisely because the gate's own run is already claimed —
   * which is the state a runner sees most of the time.
   */
  test('B2 an empty long poll is a 204 with an empty body, at the default wait', async () => {
    expect(RUN_CLAIM_WAIT_MS).toBe(25_000);
    expect(one(await psql(
      "select count(*) from schedule_runs r join schedules s on s.id = r.schedule_id "
      + "where s.job_type = 'agent_prompt' and r.state = 'pending'",
    ))).toBe('0');

    const started = Date.now();
    const res = await claimAsRunner(MY_RUNNER_ID);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    // At least the configured window, and never more than one poll interval
    // past it: a route that returned early, or never, fails here.
    expect(elapsed).toBeGreaterThanOrEqual(RUN_CLAIM_WAIT_MS - 5_000);
    expect(elapsed).toBeLessThanOrEqual(RUN_CLAIM_WAIT_MS + 20_000);
    console.log(
      `[gate-b] B2 empty long poll: 204, nothing returned, after ${elapsed}ms `
      + `(default ${RUN_CLAIM_WAIT_MS}ms)`,
    );
  }, 180_000);

  /**
   * B3 — a heartbeat extends the lease, and a lease that has moved to another
   * owner is refused with `409 lease_lost`.
   *
   * The theft is written directly, as the brief requires: racing two claims to
   * produce it would prove the race, not the guard.
   */
  test('B3 a heartbeat extends the lease and a stolen lease is a 409', async () => {
    const before = (await runRow(runId))!;
    expect(before.leaseExpiresAt).not.toBeNull();

    const res = await runnerPost(`/api/runs/${runId}/heartbeat`, { runnerId: MY_RUNNER_ID });
    expect(res.status).toBe(200);
    const body = await readJson<{ ok: boolean; runId: string; leaseExpiresAt: string }>(res, 'heartbeat');
    expect(body.ok).toBe(true);
    expect(body.runId).toBe(runId);

    const after = (await runRow(runId))!;
    const beforeMs = new Date(before.leaseExpiresAt!).getTime();
    const afterMs = new Date(after.leaseExpiresAt!).getTime();
    expect(afterMs).toBeGreaterThan(beforeMs);
    // The response is the row: the number the runner is told is the number stored.
    expect(new Date(body.leaseExpiresAt).getTime()).toBe(afterMs);

    // The lease moves to another owner — a reclaimer, or a second runner.
    await psql(`update schedule_runs set claimed_by = '${THIEF_ID}' where id = '${runId}'`);
    const stolen = await runnerPost(`/api/runs/${runId}/heartbeat`, { runnerId: MY_RUNNER_ID });
    expect(stolen.status).toBe(409);
    const stolenBody = await readJson<{ error: string; claimedBy: string; state: string }>(
      stolen, 'stolen heartbeat',
    );
    expect(stolenBody.error).toBe('lease_lost');
    expect(stolenBody.claimedBy).toBe(THIEF_ID);
    expect(stolenBody.state).toBe('running');
    // The refused heartbeat did NOT renew the thief's lease.
    expect((await runRow(runId))!.leaseExpiresAt).toBe(after.leaseExpiresAt);

    // Put the lease back: the theft was the observation, not the state the later
    // legs work from.
    await psql(`update schedule_runs set claimed_by = '${MY_RUNNER_ID}' where id = '${runId}'`);
    expect((await runRow(runId))!.claimedBy).toBe(MY_RUNNER_ID);
    console.log(
      `[gate-b] B3 lease ${before.leaseExpiresAt} -> ${after.leaseExpiresAt}; `
      + `stolen by ${THIEF_ID} -> 409 ${stolenBody.error}`,
    );
  }, 180_000);

  /**
   * B4 — events are idempotent on `(runId, seq)`.
   *
   * The runner retries a batch after a transport blip, so the same frames will
   * arrive twice; a doubled tool call in the receipt is a receipt nobody can
   * trust. Asserted on the row count AND on the content, because `inserted: 0`
   * from a route that also wrote nothing is not the same claim as "the ledger
   * still holds exactly the frames it held".
   */
  test('B4 the same event batch twice leaves the ledger unchanged', async () => {
    const marker = `gate-b-events-${RUN_ID}`;
    const batch = [
      { seq: 0, kind: 'system', data: { marker, session: 1 } },
      { seq: 1, kind: 'assistant', data: { text: 'round one' } },
    ];

    const first = await runnerPost(`/api/runs/${runId}/events`, { events: batch });
    expect(first.status).toBe(200);
    expect(await readJson<Record<string, unknown>>(first, 'events #1'))
      .toEqual({ ok: true, inserted: 2, replayed: 0 });
    const afterFirst = await eventRows(runId);
    expect(afterFirst.length).toBe(2);

    const second = await runnerPost(`/api/runs/${runId}/events`, { events: batch });
    expect(second.status).toBe(200);
    expect(await readJson<Record<string, unknown>>(second, 'events #2'))
      .toEqual({ ok: true, inserted: 0, replayed: 2 });

    const rows = await eventRows(runId);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(rows.map((r) => r.kind)).toEqual(['system', 'assistant']);
    // Nothing was rewritten, and nothing was duplicated: the marker occurs once.
    expect(JSON.stringify(rows)).toBe(JSON.stringify(afterFirst));
    expect(JSON.stringify(rows).split(marker).length - 1).toBe(1);
    console.log(`[gate-b] B4 batch twice: 2 rows, replay reported {inserted:0,replayed:2}, content identical`);
  }, 180_000);

  /**
   * B6 — the gateway meters a real call and `agent_run_usage` gains a row.
   *
   * Exactly one real Haiku call, tiny `max_tokens`, the smallest prompt that
   * still exercises the path, driven with the token the CLAIM handed back — the
   * same token the runner would use. Three numbers have to agree: the shipped
   * price table applied to the response's own usage frame, the usage row, and
   * the run's rollup, which is `SUM(agent_run_usage.cost_usd)` by construction.
   */
  test('B6 one real metered call lands in agent_run_usage and rolls up', async () => {
    const c = needClaim();
    obs.b6Marker = `gate-b-body-${RUN_ID}`;
    const requestBody = {
      model: 'claude-haiku-4-5',
      max_tokens: 16,
      stream: false,
      messages: [{ role: 'user', content: `${obs.b6Marker}: reply with exactly ok` }],
    };

    const res = await fetchInsecure('/api/gateway/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.gateway.token}` },
      body: JSON.stringify(requestBody),
    });
    const frameText = await res.text();
    // A non-200 here is the gateway working: it forwards the upstream's own
    // error verbatim, and the org's stored provider credential is the thing that
    // ages. Say WHICH failure it is rather than reporting a bare status — a
    // rotated OAuth token answers `401 OAuth access token has been revoked`, and
    // that is an operator's rotation to make, not a defect in this lane.
    if (res.status !== 200) {
      throw new Error(
        `the gateway answered ${res.status} for run ${runId} with the token the CLAIM minted: `
        + frameText.slice(0, 300),
      );
    }
    const frame = JSON.parse(frameText) as { model: string; usage: AnthropicUsage; stop_reason: string };
    expect(typeof frame.model).toBe('string');
    expect(frame.model.length).toBeGreaterThan(0);

    const expected = priceUsage(frame.model, frame.usage);
    expect(expected).not.toBeNull();
    const counts = usageCounts(frame.usage);

    const usage = await usageRows(runId);
    expect(usage.length).toBe(1);
    const row = usage[0]!;
    expect(row.model).toBe(frame.model);
    expect(row.httpStatus).toBe(200);
    // The four counts, exactly as the response warrants them: this frame carries
    // input and output tokens and no cache traffic, so 0 is the honest value for
    // the cache columns rather than a missing one.
    expect(row.inputTokens).toBe(counts.inputTokens);
    expect(row.outputTokens).toBe(counts.outputTokens);
    expect(row.cacheReadTokens).toBe(counts.cacheReadTokens);
    expect(row.cacheWriteTokens).toBe(counts.cacheWrite5mTokens + counts.cacheWrite1hTokens);
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(row.outputTokens).toBeGreaterThan(0);
    expect(row.stopReason).toBe(frame.stop_reason);

    expect(row.costUsd).not.toBeNull();
    expect(expected).not.toBeNull();
    expect(Number(row.costUsd)).toBe(expected!);
    // The column's own shape, at the precision the harness reports.
    expect(row.costUsd).toBe(expected!.toFixed(7));

    const run = (await agentRun(runId))!;
    expect(run.costUsd).toBe(row.costUsd);
    expect(run.inputTokens).toBe(row.inputTokens);
    expect(run.outputTokens).toBe(row.outputTokens);
    expect(run.cacheReadTokens).toBe(row.cacheReadTokens);
    expect(run.cacheWriteTokens).toBe(row.cacheWriteTokens);

    // The rollup IS the aggregate, not a copy of it.
    expect(Number(one(await psql(
      `select sum(cost_usd::numeric)::text from agent_run_usage where run_id = '${runId}'`,
    )))).toBe(Number(run.costUsd));
    console.log(
      `[gate-b] B6 metered call model=${frame.model} in=${row.inputTokens} out=${row.outputTokens} `
      + `cacheRead=${row.cacheReadTokens} cacheWrite=${row.cacheWriteTokens} `
      + `cost=$${row.costUsd} rollup=$${run.costUsd}`,
    );
  }, 180_000);

  /**
   * B7 — finish revokes the run token and stamps `tokenRevokedAt`, and the same
   * bearer stops authenticating against gbrain.
   *
   * A stamp alone is not revocation, so this leg reads the credential's
   * behaviour on BOTH sides of the finish: the same bearer answers gbrain's
   * `tools/list` with 200 before and 401 after. The client is killed by id
   * (`auth revoke-client`, D8's measured mechanism) rather than by a hash
   * nothing stores.
   */
  test('B7 finish revokes the token: the same bearer works before and 401s after', async () => {
    const c = needClaim();

    const before = await mcpToolsList(c.mcp.token);
    expect(before.status).toBe(200);

    const res = await runnerPost(`/api/runs/${runId}/finish`, {
      runnerId: MY_RUNNER_ID, exitCode: 0, numTurns: 1,
    });
    expect(res.status).toBe(200);
    const finish = await readJson<{
      ok: boolean;
      result: { runId: string; state: string; classification: string; tokenRevoked: boolean };
    }>(res, 'finish');
    expect(finish.ok).toBe(true);
    expect(finish.result.runId).toBe(runId);
    expect(finish.result.state).toBe('succeeded');
    expect(finish.result.classification).toBe('ok');
    expect(finish.result.tokenRevoked).toBe(true);

    const run = (await agentRun(runId))!;
    expect(run.tokenRevokedAt).not.toBeNull();
    expect(run.gbrainClientId).not.toBeNull();
    // The meter's rollup survives the finish, and the turn count is the runner's.
    expect(Number(run.costUsd)).toBeGreaterThan(0);
    expect(run.numTurns).toBe(1);
    // The lease is released: a finished run does not hold one.
    expect((await runRow(runId))!.leaseExpiresAt).toBeNull();

    // The revocation, not the stamp: gbrain's own answer.
    const after = await mcpToolsList(c.mcp.token);
    expect(after.status).toBe(401);
    expect((await after.json() as { error?: string }).error).toBe('invalid_token');
    console.log(
      `[gate-b] B7 finish: state=${finish.result.state} tokenRevoked=${finish.result.tokenRevoked} `
      + `token_revoked_at=${run.tokenRevokedAt} client=${run.gbrainClientId} `
      + `mcp ${before.status} -> ${after.status}`,
    );
  }, 300_000);

  /**
   * B5 — the gateway refuses without a valid run token, and makes NO upstream
   * call while doing it.
   *
   * The codes are read from the shipped surface (`src/gateway/token.ts`,
   * `src/gateway/meter.ts`), never invented: a token that does not verify is
   * `invalid_gateway_token` at the route, and a token that DOES verify but whose
   * run is over is `run_terminated` from the meter's budget check — which is
   * where the token is burned, because D7's correction leaves nothing to store a
   * hash in. The "dead run" arm deliberately uses the CLAIM's own gateway token,
   * the one B6 just spent successfully: after this gate's finish, that same
   * string is refused, which is the whole difference between a stamp and a
   * revocation. The "no upstream call" half is asserted: the refusal paths write
   * no usage row, so the total recorded spend cannot move.
   */
  test('B5 the gateway refuses a missing, forged, expired or dead-run token', async () => {
    const spendBefore = await totalRecordedSpend();
    const c = needClaim();
    const deadRow = (await runRow(runId))!;
    const deadAgentRow = (await agentRun(runId))!;
    // Terminal, and provably revoked rather than merely idle.
    expect(['running', 'pending']).not.toContain(deadRow.state);
    expect(deadAgentRow.tokenRevokedAt).not.toBeNull();

    const ask = (authorization?: string) => fetchInsecure('/api/gateway/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5', max_tokens: 8,
        messages: [{ role: 'user', content: 'refuse me' }],
      }),
    });
    const codeOf = async (res: Response, label: string) =>
      (await readJson<{ error: { type?: string; code: string } }>(res, label)).error;

    // (1) no token at all.
    const none = await ask();
    expect(none.status).toBe(401);
    const noneError = await codeOf(none, 'no token');
    expect(noneError.code).toBe('invalid_gateway_token');
    expect(noneError.type).toBe('authentication_error');

    // (2) a garbage token — the SAME answer, because "forged" and "absent" are
    //     one fact: the presented value does not verify.
    const garbage = await ask('Bearer not.a.token');
    expect(garbage.status).toBe(401);
    expect((await codeOf(garbage, 'garbage token')).code).toBe('invalid_gateway_token');

    // (2b) a correctly SIGNED token whose window has passed: still a signature
    //      failure to the route, which is the honest reading — an expired
    //      signature and a forged one buy the same nothing.
    const expired = await ask(`Bearer ${mintGatewayToken(runId, 300, Date.now() - 600_000)}`);
    expect(expired.status).toBe(401);
    expect((await codeOf(expired, 'expired token')).code).toBe('invalid_gateway_token');

    // (3) the WELL-FORMED token B6 spent: the signature verifies, so the route
    //     lets it through and the meter burns it on the run's state.
    expect(verifyGatewayToken(c.gateway.token)?.runId).toBe(runId);
    const dead = await ask(`Bearer ${c.gateway.token}`);
    expect(dead.status).toBe(401);
    const deadError = await codeOf(dead, 'dead run');
    expect(deadError.code).toBe('run_terminated');
    expect(deadError.type).toBe('authentication_error');

    // (4) a well-formed token for a run that does not exist — a third distinct
    //     reason, and the one that proves the meter's lookup is what refuses.
    const unknownId = randomUUID();
    const unknown = await ask(`Bearer ${mintGatewayToken(unknownId, 300)}`);
    expect(unknown.status).toBe(401);
    expect((await codeOf(unknown, 'unknown run')).code).toBe('run_unknown');

    // No upstream call was made: every refusal above happens before the forward,
    // and none of them wrote a usage row — the run's own one row is still alone.
    expect(one(await psql(
      `select count(*) from agent_run_usage where run_id in ('${runId}', '${unknownId}')`,
    ))).toBe('1');
    expect(await totalRecordedSpend()).toBe(spendBefore);
    console.log(
      `[gate-b] B5 gateway refusals: none=${none.status}/${noneError.code} `
      + `garbage=${garbage.status}/invalid_gateway_token expired=${expired.status}/invalid_gateway_token `
      + `deadRun=${dead.status}/${deadError.code} (state ${deadRow.state}) `
      + `unknownRun=${unknown.status}/run_unknown; spend unchanged at $${spendBefore}`,
    );
  }, 180_000);

  /**
   * B8 — the run detail projection excludes both tokens and any raw request body.
   *
   * By KEY SET (the shape the projection decided, exactly) AND by VALUE SCAN (the
   * serialized body, searched for the two live credentials this gate holds and
   * for a marker that exists only inside B6's model request). A projection test
   * that only checks the keys you remembered is not this leg — and the scan is
   * kept honest by two controls: the schedule's own prompt IS in the payload, and
   * so is the metered call, so a body emptied to pass the scan would fail
   * instead.
   */
  test('B8 the run detail carries no token and no request body', async () => {
    const c = needClaim();
    const res = await fetchInsecure(`/api/runs/${runId}`, { headers: { cookie: viewerCookie } });
    expect(res.status).toBe(200);
    const detail = await readJsonQuiet<Record<string, unknown>>(res, 'run detail');

    expect(Object.keys(detail).sort()).toEqual([
      'attempt', 'budgetUsd', 'clientName', 'connectionId', 'costUsd', 'diff', 'events',
      'failureClass', 'failureDetail', 'finishedAt', 'fireAt', 'harnessVersion', 'heads',
      'model', 'numTurns', 'prompt', 'revertCommit', 'revertedAt', 'runId', 'scheduleId',
      'scheduleName', 'slot', 'startedAt', 'state', 'tokenRevokedAt', 'usage',
    ]);
    // No key may even name a credential or a raw body. `tokenRevokedAt` is the
    // one legitimate match: it is a stamp, not a token.
    expect(Object.keys(detail).filter((k) => /token|secret|bearer|authorization|body/i.test(k)))
      .toEqual(['tokenRevokedAt']);

    // The scan is not vacuous: the two credentials are real and non-empty...
    expect(c.mcp.token.length).toBeGreaterThan(20);
    expect(c.gateway.token.length).toBeGreaterThan(20);
    expect(obs.b6Marker.length).toBeGreaterThan(10);
    const serialized = JSON.stringify(detail);
    // ...and neither of them, nor B6's request body, is anywhere in the page.
    expect(serialized).not.toContain(c.mcp.token);
    expect(serialized).not.toContain(c.gateway.token);
    expect(serialized).not.toContain(obs.b6Marker);
    expect(serialized).not.toContain('max_tokens');
    // Controls: the operator's prompt and the metered call ARE here.
    expect(detail.prompt).toBe(PROMPT);
    expect(serialized).toContain(PROMPT);
    expect((detail.usage as unknown[]).length).toBe(1);
    expect((detail.events as unknown[]).length).toBe(2);
    expect(typeof detail.tokenRevokedAt).toBe('string');
    // `heads` is the pre/post capture per Space (D9), not a single sha.
    const heads = detail.heads as { before: Record<string, string>; after: Record<string, string> };
    const captured = Object.values(heads.before);
    expect(captured.length).toBeGreaterThan(0);
    for (const sha of captured) expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(heads.after).sort()).toEqual(Object.keys(heads.before).sort());
    console.log(
      `[gate-b] B8 detail keys=${Object.keys(detail).length} `
      + `credential-ish keys=${JSON.stringify(Object.keys(detail).filter((k) => /token|secret|bearer|authorization|body/i.test(k)))} `
      + `usage=${(detail.usage as unknown[]).length} events=${(detail.events as unknown[]).length} `
      + `token substrings present=0`,
    );
  }, 180_000);

  /**
   * B12 — `/api/health` reports all three runner states correctly, and only one
   * of them is green.
   *
   * `disabled` was produced for real in B10 (the lane's own environment), the
   * `connected` reading was taken while this gate's claim held a live lease, and
   * `never_claimed` is read here, live, after the finish released it. "Green" is
   * the SHIPPED mapping the console renders with (`runnerStateTone`), not a
   * second opinion invented by this gate.
   */
  test('B12 health reports disabled, never_claimed and connected, and only connected is green', async () => {
    const disabled = obs.healthDisabled;
    const connected = obs.healthConnected;
    expect(disabled).not.toBeNull();
    expect(connected).not.toBeNull();

    // The vocabulary, from the console's own pure functions.
    expect(runnerStateTone('connected')).toBe('ok');
    expect(runnerStateTone('disabled')).not.toBe('ok');
    expect(runnerStateTone('never_claimed')).not.toBe('ok');
    expect(runnerStateLabel('connected')).toBe('Runner connected');
    expect(runnerStateLabel('disabled')).toBe('Runner disabled');
    expect(runnerStateLabel('never_claimed')).not.toContain('Unknown');

    expect(disabled!.runner.state).toBe('disabled');
    expect(connected!.runner.state).toBe('connected');
    expect(connected!.runner.lastSeenAt).not.toBeNull();

    // The third state, live: this gate's run is finished, its lease released,
    // and `lastSeenAt` is now the honest discriminator — a runner WAS here.
    const never = await healthNow();
    expect(never.runner.state).toBe('never_claimed');
    expect(runnerStateTone(never.runner.state)).not.toBe('ok');
    expect(never.runner.lastSeenAt).not.toBeNull();

    // Three keys, no token, no client id — /api/health is served without a
    // session, so its runner vocabulary is closed by construction.
    for (const h of [disabled!, connected!, never]) {
      expect(Object.keys(h.runner).sort()).toEqual(['lastSeenAt', 'state', 'version']);
      expect(h.runner.version).toBeNull();
    }
    console.log(
      `[gate-b] B12 states: disabled=${JSON.stringify(disabled!.runner)} `
      + `connected=${JSON.stringify(connected!.runner)} never_claimed=${JSON.stringify(never.runner)}`,
    );
  }, 120_000);

  /**
   * The state this gate leaves — and the state it found: the lane enabled, the
   * profile's container up, both consumers idle.
   *
   * B9 stopped the container so the runner could not race the scheduler for the
   * agent row, and everything after it ran with the lane's consumer deliberately
   * absent. Putting it back is part of the gate, not the teardown: the FIRST
   * consecutive run must leave exactly what the SECOND one starts from.
   */
  test('B12b the lane is left enabled, with the container up and nothing to claim', async () => {
    expect((await compose('up', '-d', '--no-deps', 'agent-runner')).exitCode).toBe(0);
    const announced = await waitFor('the runner container to be up', 120_000, announcedRunner, 2_000);
    expect(announced.harnessVersion).toBe(HARNESS_PIN);
    const health = await healthNow();
    expect(health.runner.state).not.toBe('disabled');
    // The lane answers with an empty queue — and says so cheaply, at the
    // request-shape gate, rather than holding a poll against an idle stack.
    const shape = await fetchInsecure('/api/runs/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${runnerToken()}` },
      body: JSON.stringify({ harnessVersion: HARNESS_PIN }),
    });
    expect(shape.status).toBe(400);
    expect((await readJson<{ error: string }>(shape, 'left-enabled shape refusal')).error)
      .toBe('runner_never_seen');
    console.log(
      `[gate-b] left enabled: health.runner=${JSON.stringify(health.runner)} container=${announced.id} `
      + `harness=${announced.harnessVersion}`,
    );
  }, 180_000);

  // --- teardown: fixtures gone, stack exactly as the gate found it -----------

  afterAll(async () => {
    if (!dockerAvailable) return;

    // The gate's own rows: deleting a fixture schedule cascades through
    // schedule_runs → agent_runs → its events and usage, and the alerts
    // belonging to those runs go first so none of them names a run that no
    // longer exists. The audit rows of the route calls that created the command
    // schedule stay: audit is append-only by design.
    for (const id of [...FIXTURE_SCHEDULES, commandScheduleId].filter(Boolean)) {
      await deleteScheduleFixture(id).catch(() => { /* never mask the run's own failure */ });
    }

    // L5/D12: the lane is left ENABLED and the scheduler running. Neither is
    // optional — the next gate, and the two-consecutive-runs condition, start
    // from exactly this state.
    expect((await composeWith({}, 'up', '-d', '--force-recreate', 'control-plane')).exitCode).toBe(0);
    expect((await compose('up', '-d', '--no-deps', 'scheduler')).exitCode).toBe(0);
    expect((await composeWith({}, 'up', '-d', '--no-deps', 'agent-runner')).exitCode).toBe(0);

    const health = await waitForHealth(
      (h) => h.runner.state !== 'disabled', 180_000, 'the lane to be left enabled',
    );
    expect(health.runner.state).not.toBe('disabled');
    const announced = await waitFor('the runner container to be left running', 120_000, announcedRunner, 2_000);
    expect(announced.harnessVersion).toBe(HARNESS_PIN);
    // Nothing of this gate's is left to be claimed.
    expect(one(await psql(
      `select count(*) from schedules where name like 'gate-b-%${RUN_ID}%' or id like 'gate-b-%${RUN_ID}%'`,
    ))).toBe('0');
  }, 600_000);
});
