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

/**
 * The same route as `psql`, straight into the container instead of through the
 * compose CLI: one round trip costs ~145ms where `compose exec` costs ~300ms
 * (measured). C9's cap write has to land inside the harness's boot window, so
 * its poll cannot afford 150ms of CLI startup per attempt. No kill guard: the
 * leg's own timeout bounds a hung exec.
 */
async function psqlIn(containerId: string, sql: string): Promise<string> {
  const p = Bun.spawn(
    ['docker', 'exec', containerId, 'psql', '-U', 'gbrain', '-d', 'control', '-tAc', sql],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  if (exitCode !== 0) throw new Error(`psql failed (${exitCode}): ${stderr || stdout}`);
  return stdout.trim();
}

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
  /** The org-local wall stamp the occurrence was materialized for (C1). */
  slot: string;
  fireAt: string;
};

const RUN_ROW_FIELDS =
  "'id',r.id,'scheduleId',r.schedule_id,'state',r.state,'claimedBy',r.claimed_by,"
  + "'classification',r.classification,'attempt',r.attempt,'summary',r.summary,"
  + "'leaseExpiresAt',r.lease_expires_at,'startedAt',r.started_at,"
  + "'slot',r.slot,'fireAt',r.fire_at";

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

  // --- the named precondition (C0) -----------------------------------------
  //
  // The model gateway reads the org's upstream credential out of `secrets` on
  // every call (Task 7): with no `anthropic_api_key` row it answers `503
  // gateway_misconfigured` and B6/B5/B7/B8 then fail on that 503's
  // consequences — four failures for one missing host-side prerequisite, with
  // the reason only visible in the first one. The e2e suite cycles volumes by
  // design and NOTHING re-provisions that credential, so a cold stack lands
  // here. One actionable message instead of a cascade.
  const apiKeyRows = one(await psql(
    `select count(*) from secrets where organization_id = '${fixtureOrgId}' `
    + "and name = 'anthropic_api_key'",
  ));
  if (apiKeyRows !== '1') {
    throw new Error(
      'PRECONDITION FAILED: the organization has no ANTHROPIC_API_KEY secret '
        + `(found ${apiKeyRows} rows), so the model gateway has no upstream credential and every `
        + 'run in this gate would answer 503 gateway_misconfigured. Store one for organization '
        + `${fixtureOrgId}: the row is secrets.name = 'anthropic_api_key', and the wizard's provider `
        + 'step and the Settings page both write it. docs/runbooks/agent-runner.md, section '
        + '"Rotating the Anthropic key", is the runbook section that explains how — including the '
        + 'envelope encryption and how to verify the gateway can read it back. The e2e suite cycles '
        + 'volumes, so this credential has to be re-provisioned after such a cycle; `bun run '
        + 'seed:dev` does not store one.',
    );
  }
  console.log(
    `[gate-c] precondition: organization ${fixtureOrgId} holds an anthropic_api_key `
    + `(connection ${fixtureConnectionId} writing the \`internal\` Space)`,
  );
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

// ============================================================================
// Gate C — the Slice 4 exit gate (C1–C12)
// ============================================================================
//
// The roadmap's exit gate, verbatim:
//
//   a nightly `agent_prompt` produces a run record with cost, token counts and a
//   brain diff; killing the runner mid-run reclaims the lease without
//   double-writing; exceeding the budget cap stops the run and alerts rather than
//   silently truncating.
//
// Five shape decisions, each forced by a measurement rather than by taste:
//
//   1. **The container is the actor.** C1–C8 run the REAL `agent-runner` on the
//      REAL harness against the REAL brain, because every leg below is a
//      statement about what that process leaves behind. The gate drives
//      occurrence rows (`run-now`, or the materializer's own tick) and then
//      observes; it never runs the harness itself, so `claimed_by` is the
//      container's id and the receipt is the container's stream.
//   2. **The nightly occurrence is materialized, not fabricated.** The Gate B
//      precedent stands: an `agent_prompt` schedule cannot be created through
//      `POST /api/schedules` while no claim is live (honesty rule 8, B11's
//      control), so the FIRST occurrence of any Gate C schedule is a row. C1
//      writes a calendar row at 03:00 org-local with a caught-misfire grace and
//      a watermark one day back, so `materializeDue` — the UNMODIFIED Slice 3
//      materializer — is what creates it, at its own org-local slot, and the leg
//      asserts the slot against an Intl rendering that does not use our code.
//   3. **Things that take real time are waited for, not assumed.** The
//      materializer's tick, a 25s long poll, a lease expiry and a re-index are
//      all other processes' clocks. No fake timer can advance them.
//   4. **Read-only inspection goes through the two doors the product owns**:
//      the live control DB through its own container (`psql`), and the Space
//      repos through `gbrain-ops` (`git`, `gbrain search`) — never by reading a
//      file the product would read.
//   5. **The fence is asserted from inside** (C10, honesty rule 2): only
//      `docker compose exec agent-runner` can see that network, so the probes run
//      in there and the assertions are about their exit codes.

/** One Space's repo, through the container that holds it (S2). Read-only verbs. */
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

async function spaceGit(sourceId: string, args: string[]) {
  return await opsExec(['git', '-C', `/srv/brain-repos/${sourceId}`, ...args]);
}

/** A file exists in a Space's working tree (tracked or not). */
async function spaceHas(sourceId: string, relPath: string): Promise<boolean> {
  const r = await opsExec(['test', '-f', `/srv/brain-repos/${sourceId}/${relPath}`]);
  return r.exitCode === 0;
}

async function spaceReadFile(sourceId: string, relPath: string): Promise<string> {
  const r = await opsExec(['cat', `/srv/brain-repos/${sourceId}/${relPath}`]);
  if (r.exitCode !== 0) throw new Error(`cat ${relPath} in ${sourceId} exited ${r.exitCode}`);
  return r.stdout;
}

/**
 * `gbrain search <query> --limit N --json` in the ops container — the same
 * unqualified read L13 governs (only `federated: true` Spaces answer it).
 * Returns the slugs, in the order gbrain ranked them.
 */
async function searchSlugs(query: string, limit = 20): Promise<string[]> {
  const r = await opsExec(['gbrain', 'search', query, '--limit', String(limit), '--json'], 120_000);
  if (r.exitCode !== 0) {
    throw new Error(`gbrain search exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 300)}`);
  }
  const text = r.stdout;
  const start = text.search(/[[{]/);
  if (start < 0) return [];
  const parsed = JSON.parse(text.slice(start)) as unknown;
  const hits = Array.isArray(parsed) ? parsed : [];
  return hits
    .map((h) => (h as { slug?: unknown }).slug)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/** The runner container's own world. `compose exec` is the only way in (D1: the
 *  runner holds no DB credential and publishes nothing). */
async function runnerExec(argv: string[], timeoutMs = 120_000) {
  const p = Bun.spawn([...COMPOSE, 'exec', '-T', 'agent-runner', ...argv], {
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

type AlertRow = {
  kind: string;
  detail: Record<string, unknown> | null;
  runId: string | null;
  scheduleId: string | null;
};

async function alertsForRun(runId: string): Promise<AlertRow[]> {
  return JSON.parse(await psql(
    "select coalesce(json_agg(json_build_object('kind',a.kind,'detail',a.detail,"
    + "'runId',a.run_id,'scheduleId',a.schedule_id) order by a.at), '[]'::json) "
    + `from schedule_alerts a where a.run_id = '${runId}'`,
  )) as AlertRow[];
}

/** The gateway's own log lines for one run: `[gateway] {...status, tokens, costUsd}`.
 *  The one place the CONTROL PLANE says whether it forwarded an exchange. */
async function gatewayLines(runId: string): Promise<Array<Record<string, unknown>>> {
  const logs = await dockerLogs('control-plane', 2_000);
  return logs.split(/\r?\n/)
    .filter((l) => l.includes('[gateway]') && l.includes(runId))
    .map((l) => {
      try { return JSON.parse(l.slice(l.indexOf('{'))) as Record<string, unknown>; }
      catch { return null; }
    })
    .filter((v): v is Record<string, unknown> => v !== null);
}

/**
 * The org-local wall stamp of an instant — computed with `Intl`, i.e. NOT with
 * the product's `slotLabel`. C1 compares the row's `slot` against BOTH, so a
 * materializer that quietly stamped UTC fails the assertion rather than passing
 * it with its own arithmetic.
 */
function wallLabel(tz: string, at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

type ScheduleCols = {
  jobType: string;
  enabled: boolean;
  calendarHour: number | null;
  calendarMinute: number | null;
  slotMinute: number | null;
  intervalSeconds: number | null;
  misfireGraceSeconds: number;
  createdAt: string;
  lastMaterializedAt: string | null;
};

async function scheduleCols(id: string): Promise<ScheduleCols | null> {
  const rows = JSON.parse(await psql(
    "select coalesce(json_agg(json_build_object('jobType',s.job_type,'enabled',s.enabled,"
    + "'calendarHour',s.calendar_hour,'calendarMinute',s.calendar_minute,"
    + "'slotMinute',s.slot_minute,'intervalSeconds',s.interval_seconds,"
    + "'misfireGraceSeconds',s.misfire_grace_seconds,'createdAt',s.created_at,"
    + "'lastMaterializedAt',s.last_materialized_at)), '[]'::json) "
    + `from schedules s where s.id = '${id}'`,
  )) as ScheduleCols[];
  return rows[0] ?? null;
}

/** The Connection's own identity — what every commit this gate causes is
 *  authored as (`commitAsMember`), and what the revert refuses to guess. */
async function connectionMember(connectionId: string): Promise<{ name: string; email: string }> {
  const rows = JSON.parse(await psql(
    "select coalesce(json_agg(json_build_object('name',coalesce(u.name,u.email),'email',u.email)),"
    + "'[]'::json) from connections c join memberships m on m.id = c.membership_id "
    + `join users u on u.id = m.user_id where c.id = '${connectionId}'`,
  )) as Array<{ name: string; email: string }>;
  if (!rows[0]) throw new Error(`connection ${connectionId} has no member`);
  return rows[0];
}

/**
 * One `agent_prompt` schedule, written as a fixture. `kind` decides which half of
 * `shape_matches_kind` the row satisfies — the two branches are mutually
 * exclusive by CHECK, so this writes exactly one of them.
 */
async function insertAgentPrompt(args: {
  id: string;
  prompt: string;
  kind?: 'interval' | 'calendar';
  model?: string;
  maxTokens?: number;
  budgetUsd?: string;
  timeoutSeconds?: number;
  pin?: string;
  intervalSeconds?: number;
  calendarHour?: number;
  calendarMinute?: number;
  slotMinute?: number;
  misfireGraceSeconds?: number;
  lastMaterializedAtSql?: string;
  enabled?: boolean;
}): Promise<void> {
  const kind = args.kind ?? 'interval';
  const cols = [
    'id', 'organization_id', 'connection_id', 'name', 'kind', 'job_type', 'operation',
    'agent_prompt', 'agent_model', 'agent_max_tokens', 'agent_budget_usd',
    'agent_harness_version', 'timeout_seconds', 'misfire_grace_seconds', 'catchup_policy',
    'overlap_policy', 'report_policy', 'created_by', 'notifies', 'enabled', 'params',
    ...(kind === 'interval'
      ? ['interval_seconds', 'anchor_at']
      : ['calendar_hour', 'calendar_minute', 'slot_minute']),
    ...(args.lastMaterializedAtSql ? ['last_materialized_at'] : []),
  ];
  const vals = [
    `'${args.id}'`, `'${fixtureOrgId}'`, `'${fixtureConnectionId}'`, `'${args.id}'`,
    `'${kind}'`, `'agent_prompt'`, 'null',
    `'${args.prompt.replace(/'/g, "''")}'`, `'${args.model ?? 'claude-haiku-4-5'}'`,
    String(args.maxTokens ?? 512), `'${args.budgetUsd ?? '0.50'}'`,
    `'${args.pin ?? HARNESS_PIN}'`, String(args.timeoutSeconds ?? 300),
    String(args.misfireGraceSeconds ?? 120), `'skip'`, `'skip'`, `'never'`,
    `'${fixtureAdminUserId}'`, 'false', args.enabled === false ? 'false' : 'true', `'{}'`,
    ...(kind === 'interval'
      ? [String(args.intervalSeconds ?? 3600), 'now()']
      : [String(args.calendarHour ?? 3), String(args.calendarMinute ?? 0), String(args.slotMinute ?? 5)]),
    ...(args.lastMaterializedAtSql ? [args.lastMaterializedAtSql] : []),
  ];
  const got = one(await psql(`insert into schedules (${cols.join(',')}) values (${vals.join(',')}) returning id`));
  expect(got).toBe(args.id);
}

/**
 * The run's per-run gbrain bearer, recovered from the credential journal gbrain
 * wrote for that client (F7: `mcp grant` leaves one, `agent_runs.
 * gbrain_client_id` names it). The gate never sees the claim that carried the
 * token — the CONTAINER claimed it — so this is the only way to hold the
 * credential whose revocation C7 has to watch. The value is never printed.
 */
async function journalBearer(clientId: string): Promise<string | null> {
  const r = await opsExec([
    'sh', '-lc',
    `f=$(ls -1 $GBRAIN_HOME/.gbrain/credential-deliveries/*${clientId}*.json 2>/dev/null | head -1); `
    + '[ -n "$f" ] && cat "$f"',
  ], 60_000);
  if (r.exitCode !== 0 || r.stdout.trim() === '') return null;
  try {
    const parsed = JSON.parse(r.stdout) as { access_token?: unknown };
    return typeof parsed.access_token === 'string' && parsed.access_token.length > 0
      ? parsed.access_token
      : null;
  } catch { return null; }
}

/** Every `tool_use` block the receipt carries, with the event it arrived on. */
function toolUsesOf(
  events: Array<{ seq: number; kind: string; data: unknown }>,
): Array<{ seq: number; name: string; input: Record<string, unknown> }> {
  const out: Array<{ seq: number; name: string; input: Record<string, unknown> }> = [];
  for (const e of events) {
    const content = (e.data as { message?: { content?: unknown } } | null)?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; name?: unknown; input?: unknown };
      if (b?.type === 'tool_use' && typeof b.name === 'string') {
        out.push({ seq: e.seq, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
      }
    }
  }
  return out;
}

// --- Gate C's fixture identities and shared observations ---------------------

const C_NIGHTLY_SCHEDULE = `gate-c-nightly-${RUN_ID}`;
const C_KILL_SCHEDULE = `gate-c-kill-${RUN_ID}`;
const C_BUDGET_SCHEDULE = `gate-c-budget-${RUN_ID}`;
const C_BASH_SCHEDULE = `gate-c-bash-${RUN_ID}`;
/** C1's barrier: a schedule no runner can accept (a pin the runner does not
 *  carry), used only to prove the paused lane is quiet. It never spends money:
 *  a claim of it is refused by the pin handshake before the mint (B1). */
const C_SENTINEL_SCHEDULE = `gate-c-sentinel-${RUN_ID}`;
/**
 * How long a sentinel row must survive, untouched, for the lane to count as
 * quiet. Derived from the product's own bound rather than guessed: a claim
 * request lives at most `RUN_CLAIM_WAIT_MS` (`src/agent/claim.ts`), so a row
 * that outlives one full window plus a margin was seen by no claim handler at
 * all — live runner or orphaned request.
 */
const QUIET_WINDOW_MS = RUN_CLAIM_WAIT_MS + 6_000;

/** C1–C6's page: the agent's own work, in the write Space, unique to this run. */
const C_PAGE_SLUG = `gate-c/${RUN_ID}/nightly`;
const C_PAGE_TEXT = `Slice 4 gate C nightly page ${RUN_ID}.`;
const C_NIGHTLY_PROMPT =
  `Use the mcp__gbrain__put_page tool to write the page "${C_PAGE_SLUG}" with the content `
  + `"${C_PAGE_TEXT}". Then reply with exactly: done`;

/** C7/C8's pages: two writes, so the killed attempt has real work on disk before
 *  the retry redoes it (D11: "prefer upsert-by-slug writes so a retry that redoes
 *  work converges instead of duplicating"). */
const C_KILL_A = `gate-c/${RUN_ID}/kill-a`;
const C_KILL_B = `gate-c/${RUN_ID}/kill-b`;
const C_KILL_PROMPT =
  `Use the mcp__gbrain__put_page tool twice: first write the page "${C_KILL_A}" with the content `
  + `"kill-a ${RUN_ID}", then write the page "${C_KILL_B}" with the content "kill-b ${RUN_ID}". `
  + 'Then reply with exactly: done';

/** C9's run: the work the plan's cap leg would have the agent attempt — a read
 *  and a write — so the refusal is what stops it, not the prompt. */
const C_BUDGET_SLUG = `gate-c/${RUN_ID}/budget`;
const C_BUDGET_PROMPT =
  `First call mcp__gbrain__search with the query "widget". Then call mcp__gbrain__put_page to write `
  + `the page "${C_BUDGET_SLUG}" with the content "budget ${RUN_ID}". Then reply with exactly: done`;

/** C11's prompt: it asks for a tool the surface does not carry. */
const C_BASH_PROMPT =
  `Run the Bash tool with the command "id" and reply with its output. If you have no Bash tool, `
  + `reply with exactly: no-bash ${RUN_ID}`;

const cObs: {
  nightlyRunId: string;
  nightlyBefore: string;
  nightlyAfter: string;
  nightlyCommitSubject: string;
  revertCommit: string;
  killRunId: string;
  killAttemptOneSlot: string;
  killClientId: string;
  killBearerLive: number;
  killBearerDead: number;
  killedWritePresent: boolean;
  retryRunId: string;
  budgetRunId: string;
  bashRunId: string;
  bashDenials: unknown;
} = {
  nightlyRunId: '', nightlyBefore: '', nightlyAfter: '', nightlyCommitSubject: '',
  revertCommit: '', killRunId: '', killAttemptOneSlot: '', killClientId: '',
  killBearerLive: 0, killBearerDead: 0, killedWritePresent: false,
  retryRunId: '', budgetRunId: '', bashRunId: '', bashDenials: null,
};

const C_FIXTURES: string[] = [];

describe('Slice 4 exit gate C', () => {
  /**
   * Hygiene the gate owes the next run: a FAILED attempt leaves an untracked
   * page behind (a killed run's write, or a leg that failed before its finish),
   * and the write Space has to be clean for the consecutive-run condition. The
   * clean is scoped to this gate's own folder and to untracked files only — a
   * committed page from an earlier run is history, and stays.
   */
  beforeAll(async () => {
    if (!dockerAvailable) return;
    await opsExec(['sh', '-lc',
      'cd /srv/brain-repos/internal && git clean -fdq -- gate-c 2>/dev/null; true']);
  });

  /**
   * C1 — a nightly `agent_prompt` materializes at its slot in org-local time,
   * through the UNMODIFIED Slice 3 materializer.
   *
   * The clock this leg proves the row against: `organizations.timezone`, read
   * live from the control DB — that column is what `materializeDue` passes to
   * `slotLabel`. The row must appear from the leader TICK (nothing in this leg
   * calls a route), at 03:00 on the org's own wall, with `attempt = 1` and
   * `state = 'pending'`. The 03:00 occurrence is a caught misfire rather than a
   * skipped one because the fixture's `misfire_grace_seconds` covers the eleven
   * hours between 03:00 and now — the gate cannot make the scheduler's clock say
   * 03:00, and a `skipped_catchup` row would not be a run.
   */
  test('C1 a nightly agent_prompt materializes at its slot in org-local time', async () => {
    // The consumer is PAUSED for this leg — the same technique B9 uses to hold a
    // lane still — so the row the materializer writes can be observed in the
    // state it was written in. C2 brings the container back, and the claim it
    // makes is what this window makes unambiguous: the scheduler's own ticks run
    // throughout and never touch an `agent_prompt` row.
    //
    // A stopped container is not yet a quiet lane: the claim route long-polls the
    // database for RUN_CLAIM_WAIT_MS, and a request whose client has been killed
    // keeps polling until the window closes — so a row inserted too early can be
    // claimed by a handler that no longer has a runner behind it (measured: the
    // row went `running` with a `claimed_by` naming a container that had already
    // exited). The pause is therefore PROVEN before it is relied on, with a
    // sentinel row no runner can accept (a pin the runner does not carry, so a
    // stray claim is refused before any mint): it must survive the whole poll
    // window, untouched.
    expect((await compose('stop', 'agent-runner')).exitCode).toBe(0);
    C_FIXTURES.push(C_SENTINEL_SCHEDULE);
    await insertAgentPrompt({
      id: C_SENTINEL_SCHEDULE,
      prompt: 'gate C sentinel: never runs',
      // DISABLED on purpose: a claim request that reaches this row consumes it as
      // `skipped_overlap` inside `claimNextRun` — no mint, no alert, no money —
      // which is exactly the trace this barrier needs and nothing more.
      enabled: false,
    });
    let quietMs = 0;
    let quietTries = 0;
    let sentinelRunId = '';
    // Bounded by the same window the barrier measures: an orphaned request can
    // only be alive for one RUN_CLAIM_WAIT_MS after the stop, so three windows is
    // more than enough, and each retry states which case it saw.
    const quietDeadline = Date.now() + 3 * QUIET_WINDOW_MS;
    while (Date.now() < quietDeadline && quietMs < QUIET_WINDOW_MS) {
      quietTries += 1;
      sentinelRunId = one(await psql(
        'insert into schedule_runs (id, schedule_id, organization_id, slot, fire_at, state, attempt) '
        + `values (gen_random_uuid(), '${C_SENTINEL_SCHEDULE}', '${fixtureOrgId}', `
        + `'sentinel:${RUN_ID}:${quietTries}', now(), 'pending', 1) returning id`,
      ));
      const since = Date.now();
      let consumed = false;
      while (Date.now() - since < QUIET_WINDOW_MS && !consumed) {
        const sentinel = (await runRow(sentinelRunId))!;
        consumed = sentinel.state !== 'pending';
        if (!consumed) {
          expect(sentinel.claimedBy).toBeNull();
          await Bun.sleep(2_500);
        }
      }
      if (consumed) {
        // A request outlived its client and consumed the sentinel on its next
        // poll — costs nothing (the schedule is disabled, so it is skipped rather
        // than minted) and this retry is the observation that says so.
        await psql(`delete from schedule_runs where id = '${sentinelRunId}'`);
        quietMs = 0;
      } else {
        quietMs = Date.now() - since;
      }
    }
    expect(quietMs).toBeGreaterThanOrEqual(QUIET_WINDOW_MS);
    console.log(`[gate-c] C1 the lane is quiet: a sentinel pending row survived ${quietMs}ms `
      + `(window ${QUIET_WINDOW_MS}ms) after ${quietTries} attempt(s)`);
    // Out of the way, so C2's claim takes the nightly occurrence and nothing else.
    await psql(`delete from schedule_runs where id = '${sentinelRunId}'`);
    const tz = one(await psql(`select timezone from organizations where id = '${fixtureOrgId}'`));
    expect(tz).toMatch(/^[A-Za-z_]+(\/[A-Za-z_+-]+)?$/);
    const writeSpaceSource = one(await psql(
      `select s.source_id from connections c join spaces s on s.id = c.write_space_id `
      + `where c.id = '${fixtureConnectionId}'`,
    ));
    expect(writeSpaceSource).toBe('internal');
    const readSources = JSON.parse(await psql(
      "select coalesce(json_agg(s.source_id order by s.source_id), '[]'::json) from spaces s where s.id in "
      + `(select jsonb_array_elements_text(c.read_space_ids) from connections c `
      + `where c.id = '${fixtureConnectionId}') and s.id <> `
      + `(select write_space_id::text from connections where id = '${fixtureConnectionId}')`,
    )) as string[];
    expect(readSources).toEqual(['customers']);

    C_FIXTURES.push(C_NIGHTLY_SCHEDULE);
    // The nightly row, and a watermark an hour before the MOST RECENT 03:00 in
    // the org's own timezone. `materializeDue` enumerates (watermark, now], so
    // exactly that occurrence is due — tonight's 03:00 once it has passed, last
    // night's when the gate runs in the small hours. The two-day grace is what
    // makes it a CAUGHT misfire rather than a `skipped_catchup` row: this gate
    // cannot make the scheduler's clock say 03:00, and a skipped row is not a run.
    await insertAgentPrompt({
      id: C_NIGHTLY_SCHEDULE,
      prompt: C_NIGHTLY_PROMPT,
      kind: 'calendar',
      calendarHour: 3,
      calendarMinute: 0,
      slotMinute: 5,
      misfireGraceSeconds: 172_800,
      lastMaterializedAtSql:
        `((case when extract(hour from (now() at time zone '${tz}')) >= 3 `
        + `then date_trunc('day', now() at time zone '${tz}') + interval '2 hours' `
        + `else date_trunc('day', now() at time zone '${tz}') - interval '22 hours' end) `
        + `at time zone '${tz}')`,
    });
    const inserted = (await scheduleCols(C_NIGHTLY_SCHEDULE))!;
    expect(inserted.calendarHour).toBe(3);
    expect(inserted.calendarMinute).toBe(0);
    expect(inserted.misfireGraceSeconds).toBe(172_800);

    // The tick creates it. Nothing else in this file writes a `schedule_runs`
    // row for this schedule, and `run-now` would stamp a `manual:` slot — which
    // is exactly what the slot assertion below discriminates against.
    const row = await waitFor('the nightly occurrence to materialize', 120_000, async () => {
      const rows = await runsOf(C_NIGHTLY_SCHEDULE);
      return rows.length === 1 ? rows[0]! : null;
    }, 3_000);

    const fireAt = new Date(row.fireAt);
    const orgWall = wallLabel(tz, fireAt);
    const utcWall = wallLabel('UTC', fireAt);
    // The wall stamp the materializer chose is the org-local rendering of its own
    // fire instant — and it is 03:00 on that clock.
    expect(row.slot).toBe(orgWall);
    expect(orgWall.endsWith('T03:00')).toBe(true);
    if (tz !== 'UTC') expect(row.slot).not.toBe(utcWall);
    expect(row.slot.startsWith('manual:')).toBe(false);
    // The occurrence really is in the past (a misfire caught by the grace), and
    // it is the most recent 03:00 rather than an older one.
    expect(fireAt.getTime()).toBeLessThan(Date.now());
    expect(Date.now() - fireAt.getTime()).toBeLessThan(26 * 3_600_000);
    expect(row.state).toBe('pending');
    expect(row.attempt).toBe(1);
    expect(row.claimedBy).toBeNull();
    expect(row.classification).toBeNull();

    // The schedule's own watermark moved: the TICK ran, and a second tick is
    // idempotent on (schedule_id, slot). The second tick is awaited by its own
    // watermark rather than by a sleep: the leader writes `last_materialized_at`
    // every tick, so a further move IS a further tick.
    const after = (await scheduleCols(C_NIGHTLY_SCHEDULE))!;
    expect(after.lastMaterializedAt).not.toBeNull();
    expect(new Date(after.lastMaterializedAt!).getTime()).toBeGreaterThan(
      new Date(inserted.createdAt).getTime(),
    );
    const secondTick = await waitFor('the leader\'s next tick', 90_000, async () => {
      const now = await scheduleCols(C_NIGHTLY_SCHEDULE);
      return now?.lastMaterializedAt && now.lastMaterializedAt !== after.lastMaterializedAt
        ? now.lastMaterializedAt
        : null;
    }, 3_000);
    expect(secondTick).not.toBe(after.lastMaterializedAt);
    const stillPending = (await runsOf(C_NIGHTLY_SCHEDULE))!;
    expect(stillPending.length).toBe(1);
    // The scheduler's own ticks ran (the watermark moved twice) and left the row
    // alone: an `agent_prompt` occurrence has one consumer, and it is not that one.
    expect(stillPending[0]!.state).toBe('pending');
    expect(stillPending[0]!.claimedBy).toBeNull();

    console.log(
      `[gate-c] C1 nightly ${C_NIGHTLY_SCHEDULE} materialized slot=${row.slot} `
      + `fire_at=${row.fireAt} (org tz ${tz}, UTC wall ${utcWall}) attempt=${row.attempt} `
      + `state=${row.state} tick watermark ${after.lastMaterializedAt} -> ${secondTick} `
      + 'with the row count still 1',
    );
  }, 300_000);

  /**
   * C2 — the real container claims it, and the scheduler never touched the row.
   *
   * Both consumers write `claimed_by` in the same shape (`${HOSTNAME}-${uuid8}`),
   * so the assertion is not the shape: it is the id the RUNNER container
   * announced on its own stdout, against the id the SCHEDULER process announced.
   * A row the scheduler claimed would carry the second one, and the runner lane's
   * own claim is what mints the per-run credentials recorded below.
   */
  test('C2 the runner container claims the occurrence, and not the scheduler', async () => {
    // C1 paused the lane; bringing it back is what produces the claim — the same
    // `--no-deps` start the gate uses everywhere, so the container announces a
    // fresh id and long-polls the control plane it was recreated against.
    expect((await compose('up', '-d', '--no-deps', '--force-recreate', 'agent-runner')).exitCode).toBe(0);
    const announced = await waitFor('the runner container to announce itself', 120_000, announcedRunner, 2_000);
    expect(announced.harnessVersion).toBe(HARNESS_PIN);
    const schedulerId = await schedulerWorker();
    expect(schedulerId).not.toBeNull();

    const row = await waitFor('the runner container to claim the nightly run', 180_000, async () => {
      const r = (await runsOf(C_NIGHTLY_SCHEDULE))[0];
      return r?.state === 'running' ? r : null;
    }, 2_000);

    expect(row.claimedBy).toBe(announced!.id);
    expect(row.claimedBy).not.toBe(schedulerId!);
    expect(row.claimedBy).not.toBe(MY_RUNNER_ID);
    expect(row.leaseExpiresAt).not.toBeNull();
    expect(row.startedAt).not.toBeNull();
    cObs.nightlyRunId = row.id;

    // The claim minted the run's own credentials: one gbrain client (D8's
    // fallback arm), and an `agent_runs` row carrying the schedule's payload.
    const stored = (await agentRun(row.id))!;
    expect(stored.model).toBe('claude-haiku-4-5');
    expect(stored.gbrainClientId).not.toBeNull();
    expect(stored.tokenRevokedAt).toBeNull();
    expect(stored.costUsd).toBeNull();

    const heads = JSON.parse(await psql(
      "select json_build_object('before',a.heads_before,'after',a.heads_after)::text "
      + `from agent_runs a where a.run_id = '${row.id}'`,
    )) as { before: Record<string, string>; after: Record<string, string> | null };
    expect(Object.keys(heads.before).sort()).toEqual(['customers', 'internal']);
    expect(heads.after).toBeNull();
    cObs.nightlyBefore = heads.before.internal!;

    console.log(
      `[gate-c] C2 claimed_by=${row.claimedBy} (scheduler is ${schedulerId}) run=${row.id} `
      + `lease=${row.leaseExpiresAt} client=${stored.gbrainClientId} `
      + `heads=${JSON.stringify(heads.before)}`,
    );
  }, 300_000);

  /**
   * C3 — the run completes, and the rollup is the aggregate.
   *
   * Four non-zero token counts and a non-null cost are the roadmap's "a run
   * record with cost and token counts". The equality is the part that makes the
   * rollup trustworthy: `agent_runs.cost_usd` is DEFINED as
   * `SUM(agent_run_usage.cost_usd)`, so the leg computes BOTH sides in SQL and
   * compares the stored text — not a number this test re-derived.
   */
  test('C3 the run completes with cost, four non-zero token counts, and the rollup equality', async () => {
    const runId = cObs.nightlyRunId;
    const row = await waitFor('the nightly run to finish', 600_000, async () => {
      const r = await runRow(runId);
      return r && r.state !== 'running' && r.state !== 'pending' ? r : null;
    }, 3_000);

    expect(row.state).toBe('succeeded');
    expect(row.classification).toBe('ok');
    const stored = (await agentRun(runId))!;
    expect(stored.failureClass).toBeNull();
    expect(stored.costUsd).not.toBeNull();
    expect(Number(stored.costUsd)).toBeGreaterThan(0);
    expect(stored.inputTokens).toBeGreaterThan(0);
    expect(stored.outputTokens).toBeGreaterThan(0);
    expect(stored.cacheReadTokens).toBeGreaterThan(0);
    expect(stored.cacheWriteTokens).toBeGreaterThan(0);
    expect(stored.numTurns).toBeGreaterThanOrEqual(2);
    expect(stored.tokenRevokedAt).not.toBeNull();

    const rollup = JSON.parse(await psql(
      "select json_build_object("
      + "'calls',(select count(*) from agent_run_usage where run_id = '" + runId + "'),"
      + "'sumCost',(select sum(cost_usd::numeric)::text from agent_run_usage where run_id = '" + runId + "'),"
      + "'runCost',(select cost_usd from agent_runs where run_id = '" + runId + "'),"
      + "'usageInput',(select sum(input_tokens)::text from agent_run_usage where run_id = '" + runId + "'),"
      + "'runInput',(select input_tokens::text from agent_runs where run_id = '" + runId + "'),"
      + "'usageOutput',(select sum(output_tokens)::text from agent_run_usage where run_id = '" + runId + "'),"
      + "'runOutput',(select output_tokens::text from agent_runs where run_id = '" + runId + "'),"
      + "'usageCacheRead',(select sum(cache_read_tokens)::text from agent_run_usage where run_id = '" + runId + "'),"
      + "'runCacheRead',(select cache_read_tokens::text from agent_runs where run_id = '" + runId + "'),"
      + "'usageCacheWrite',(select sum(cache_write_tokens)::text from agent_run_usage where run_id = '" + runId + "'),"
      + "'runCacheWrite',(select cache_write_tokens::text from agent_runs where run_id = '" + runId + "'),"
      + "'nullCostRows',(select count(*) from agent_run_usage where run_id = '" + runId + "' and cost_usd is null)"
      + ')::text',
    )) as Record<string, string>;

    expect(Number(rollup.nullCostRows)).toBe(0);
    // The equality, both sides read from the database.
    expect(rollup.sumCost).toBe(rollup.runCost);
    expect(rollup.usageInput).toBe(rollup.runInput);
    expect(rollup.usageOutput).toBe(rollup.runOutput);
    expect(rollup.usageCacheRead).toBe(rollup.runCacheRead);
    expect(rollup.usageCacheWrite).toBe(rollup.runCacheWrite);
    // Non-vacuous: the run really made more than one metered call.
    expect(Number(rollup.calls)).toBeGreaterThanOrEqual(2);

    console.log(
      `[gate-c] C3 run=${runId} state=${row.state} calls=${rollup.calls} `
      + `cost=$${stored.costUsd} sum(usage)=$${rollup.sumCost} `
      + `tokens in=${stored.inputTokens} out=${stored.outputTokens} `
      + `cacheRead=${stored.cacheReadTokens} cacheWrite=${stored.cacheWriteTokens} `
      + `turns=${stored.numTurns}`,
    );
  }, 600_000);

  /**
   * C4 — the brain diff: the write Space moved and named its files; every OTHER
   * Space of the Connection did not move at all.
   *
   * "The finish path commits the run's writes itself" is what makes the range
   * real (P8: an MCP `put_page` leaves an untracked file and gbrain makes no
   * commit), so the leg asserts the commit exists, that its author is the
   * Connection's member, and that the file list is the agent's work — from the
   * repo, not from the product's own summary of it.
   */
  test('C4 the write Space moved and named its files; no read Space moved', async () => {
    const runId = cObs.nightlyRunId;
    const heads = JSON.parse(await psql(
      "select json_build_object('before',a.heads_before,'after',a.heads_after)::text "
      + `from agent_runs a where a.run_id = '${runId}'`,
    )) as { before: Record<string, string>; after: Record<string, string> };
    cObs.nightlyBefore = heads.before.internal!;
    cObs.nightlyAfter = heads.after.internal!;

    expect(cObs.nightlyAfter).not.toBe(cObs.nightlyBefore);
    // The read Space (the Connection reads `internal` itself, which the claim
    // filters out as the write Space, and `customers`) is untouched.
    expect(heads.after.customers).toBe(heads.before.customers);
    expect(one(await psql(
      `select count(*) from schedule_alerts where run_id = '${runId}' and kind = 'agent_read_space_moved'`,
    ))).toBe('0');

    const relPath = `${C_PAGE_SLUG}.md`;
    const range = await spaceGit('internal', [
      'log', '--name-status', '--format=%H%x1f%an%x1f%ae%x1f%s', `${cObs.nightlyBefore}..${cObs.nightlyAfter}`,
    ]);
    expect(range.exitCode).toBe(0);
    expect(range.stdout).toContain(relPath);
    // The commit is the run's, attributed to the Connection's member.
    const member = await connectionMember(fixtureConnectionId);
    expect(range.stdout).toContain(`${member.email}`);
    expect(range.stdout).toContain(`agent run ${runId}`);
    cObs.nightlyCommitSubject = range.stdout.trim();
    // One commit, and it ADDED the page: the agent's work, not a copy of someone
    // else's.
    const added = await spaceGit('internal', [
      'log', '--diff-filter=A', '--name-only', '--format=%H', `${cObs.nightlyBefore}..${cObs.nightlyAfter}`,
    ]);
    expect(added.stdout.split(/\r?\n/).filter((l) => l.trim() === relPath).length).toBe(1);

    // The read Space's own range is empty, straight from git.
    const readRange = await spaceGit('customers', [
      'log', '--format=%H', `${heads.before.customers}..${heads.after.customers}`,
    ]);
    expect(readRange.exitCode).toBe(0);
    expect(readRange.stdout.trim()).toBe('');
    // And the working tree the agent wrote into carries nothing leftover: the
    // finish committed everything it touched.
    const status = await spaceGit('internal', ['status', '--porcelain', '--untracked-files=all']);
    expect(status.stdout.trim()).toBe('');

    console.log(
      `[gate-c] C4 internal ${cObs.nightlyBefore.slice(0, 8)}..${cObs.nightlyAfter.slice(0, 8)} `
      + `files=[${relPath}] author=${member.email}; customers `
      + `${heads.before.customers!.slice(0, 8)}..${heads.after.customers!.slice(0, 8)} EMPTY`,
    );
  }, 180_000);

  /**
   * C5 — honesty rule 11: prompt, tool calls, tokens, cost and diff land in ONE
   * response.
   *
   * Not five endpoints and not "the console could join them": the projection the
   * viewer route returns is asserted key by key, and each of the five is
   * non-empty — the prompt is the schedule's, the tool call names the MCP tool
   * the harness used, the usage rows carry the tokens, the cost is the rollup
   * C3 proved, and the diff names the file C4 found.
   */
  test('C5 GET /api/runs/:id carries prompt, tool calls, tokens, cost and diff in one response', async () => {
    const runId = cObs.nightlyRunId;
    const res = await fetchInsecure(`/api/runs/${runId}`, { headers: { cookie: viewerCookie } });
    expect(res.status).toBe(200);
    const detail = await readJsonQuiet<Record<string, unknown>>(res, 'run detail');

    expect(detail.runId).toBe(runId);
    expect(detail.prompt).toBe(C_NIGHTLY_PROMPT);

    const events = detail.events as Array<{ seq: number; kind: string; data: unknown }>;
    const uses = toolUsesOf(events);
    expect(uses.map((u) => u.name)).toContain('mcp__gbrain__put_page');

    const usage = detail.usage as Array<{
      inputTokens: number; outputTokens: number; cacheReadTokens: number;
      cacheWriteTokens: number; costUsd: string;
    }>;
    expect(usage.length).toBeGreaterThanOrEqual(2);
    // Every row is a call: it produced output. The input side may be mostly cache
    // traffic, so the rollup is what has to be non-zero on all four counts — the
    // same four C3 proves from SQL.
    expect(usage.every((u) => u.outputTokens > 0)).toBe(true);
    expect(usage.reduce((n, u) => n + u.inputTokens, 0)).toBeGreaterThan(0);
    expect(usage.reduce((n, u) => n + u.cacheReadTokens, 0)).toBeGreaterThan(0);
    expect(usage.reduce((n, u) => n + u.cacheWriteTokens, 0)).toBeGreaterThan(0);

    expect(typeof detail.costUsd).toBe('string');
    expect(Number(detail.costUsd)).toBeGreaterThan(0);

    const diff = detail.diff as { write: { sourceId: string; files: Array<{ path: string }> } };
    expect(diff.write.sourceId).toBe('internal');
    expect(diff.write.files.map((f) => f.path)).toContain(`${C_PAGE_SLUG}.md`);

    console.log(
      `[gate-c] C5 one payload: prompt=${String(detail.prompt).slice(0, 40)}… `
      + `toolUses=[${uses.map((u) => u.name).join(',')}] usage=${usage.length} `
      + `cost=$${detail.costUsd} files=[${diff.write.files.map((f) => f.path).join(',')}]`,
    );
  }, 180_000);

  /**
   * C6 — revert, all three halves. The third is honesty rule 7 and it is the one
   * that gets dropped: **a reverted file that still answers searches is not
   * reverted**.
   *
   * The control that makes the search half discriminate is the middle step: the
   * page IS searchable before the revert. Without it, "the search no longer
   * returns it" would pass on a page that was never indexed.
   */
  test('C6 revert restores the tree, is committed by the acting admin, and clears the index', async () => {
    const runId = cObs.nightlyRunId;
    const relPath = `${C_PAGE_SLUG}.md`;
    const query = `gate C nightly page ${RUN_ID}`;

    // (a) the page the agent wrote is real and searchable — the pre-condition of
    //     the last third of this leg.
    expect(await spaceHas('internal', relPath)).toBe(true);
    expect(await spaceReadFile('internal', relPath)).toContain(C_PAGE_TEXT);
    const before = await waitFor('the page to answer a search', 120_000, async () => {
      const slugs = await searchSlugs(query, 20);
      return slugs.includes(C_PAGE_SLUG) ? slugs : null;
    }, 5_000);

    // (b) the revert, through the published admin route.
    const res = await scheduledPost(`/api/runs/${runId}/revert`, {});
    expect(res.status).toBe(200);
    const outcome = await readJsonQuiet<{
      reverted: boolean; revertCommit: string; sourceId: string; files: Array<{ path: string }>;
      index: { sync: { exitCode: number }; embed: { exitCode: number } };
    }>(res, 'revert');
    expect(outcome.reverted).toBe(true);
    expect(outcome.sourceId).toBe('internal');
    expect(outcome.revertCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(outcome.index.sync.exitCode).toBe(0);
    cObs.revertCommit = outcome.revertCommit;

    // The file is back to its pre-run state: it did not exist before the run, so
    // it does not exist now.
    expect(await spaceHas('internal', relPath)).toBe(false);
    const tracked = await spaceGit('internal', ['ls-files', '--', relPath]);
    expect(tracked.stdout.trim()).toBe('');

    // (c) the revert commit exists and is authored by the ACTING ADMIN — the
    //     audit story is a named human, not "the system". The identity is the
    //     session user's row, which is what the route passes to `commitAs`.
    const admin = JSON.parse(await psql(
      "select json_build_object('name',coalesce(u.name,u.email),'email',u.email)::text "
      + `from users u where u.id = '${fixtureAdminUserId}'`,
    )) as { name: string; email: string };
    expect(admin.email).toBe(ADMIN_EMAIL);
    const revertLog = await spaceGit('internal', [
      'log', '-1', '--format=%H%x1f%an%x1f%ae%x1f%s', outcome.revertCommit,
    ]);
    expect(revertLog.stdout).toContain(outcome.revertCommit);
    expect(revertLog.stdout).toContain(`revert: agent run ${runId}`);
    expect(revertLog.stdout).toContain(admin.email);
    const storedRevert = JSON.parse(await psql(
      "select json_build_object('revertedAt',a.reverted_at,'revertCommit',a.revert_commit)::text "
      + `from agent_runs a where a.run_id = '${runId}'`,
    )) as { revertedAt: string | null; revertCommit: string | null };
    expect(storedRevert.revertedAt).not.toBeNull();
    expect(storedRevert.revertCommit).toBe(outcome.revertCommit);

    // (d) honesty rule 7: the index moved with the tree. **This is the clause the
    //     plan calls out as most likely to be quietly dropped, and it is the one
    //     that fails on the shipped product.**
    //
    //     The failure is reported here rather than softened, because it is a
    //     defect in the revert path and not in this gate: the file is gone from
    //     the tree and from git, the revert commit landed, the route's re-index
    //     step exited 0 (asserted above) — and the page still answers searches.
    //     The mechanism was reproduced without a run, in
    //     `docs/slice-4-findings.md`'s F15: gbrain's `sync` prunes a page it
    //     IMPORTED from a file, but a page created the way every agent run
    //     creates one (`put_page` is brain-first; the file is write-through) keeps
    //     its page row and chunk when that file is deleted; `sync --full` does
    //     not remove it either, and only a page-level `gbrain delete <slug>
    //     --purge` does.
    // The route's re-index is synchronous (`sync` + `embed --stale` both completed
    // before it answered), so the index has already moved by the time the response
    // is in hand; the window is margin, not the mechanism.
    const gone: string[] = [];
    const searchDeadline = Date.now() + 120_000;
    let forgotten = false;
    while (Date.now() < searchDeadline && !forgotten) {
      gone.length = 0;
      gone.push(...await searchSlugs(query, 20));
      forgotten = !gone.includes(C_PAGE_SLUG);
      if (!forgotten) await Bun.sleep(5_000);
    }
    if (!forgotten) {
      throw new Error(
        `honesty rule 7 VIOLATED: run ${runId} was reverted (commit ${outcome.revertCommit.slice(0, 8)}, `
        + 'the file is gone from the write Space and from git), and the route reported a successful '
        + `re-index (sync exit ${outcome.index.sync.exitCode}), yet gbrain still returns the page for `
        + `the query "${query}": ${JSON.stringify(gone.slice(0, 5))}. The revert's re-index is the `
        + 'incremental `gbrain sync --source internal` + `embed --stale`, and gbrain prunes only pages '
        + 'it imported FROM A FILE; a page created by an MCP `put_page` has no such provenance, so its '
        + 'page row and chunk outlive the file. Reproduced with no run and no model call: `gbrain put '
        + '<slug>` + write that file + commit + `gbrain sync --source internal` + `git rm` + commit + '
        + '`gbrain sync --source internal` reports deleted: 1 and the page still answers; `gbrain sync '
        + '--full` reports deleted: 0 and it still answers; `gbrain delete <slug> --purge` removes it. '
        + 'The fix belongs in the revert path (delete the pages the reverted range removed), not in '
        + 'this gate.',
      );
    }

    console.log(
      `[gate-c] C6 revert commit=${outcome.revertCommit.slice(0, 8)} author=${admin.email}; `
      + `file absent; search before=[${before.slice(0, 3).join(',')}] `
      + `after=[${gone.slice(0, 3).join(',')}] (slug gone)`,
    );
  }, 600_000);

  /**
   * C7 — killing the runner mid-run reclaims the lease, and the RECLAIMER
   * revokes the run's token.
   *
   * The kill is real (`docker compose kill`, SIGKILL to the container) and it
   * lands while the harness is working: the leg waits for the first page the
   * agent wrote to exist on disk before it kills, so the abandoned run has left
   * work behind — which is exactly the material C8's double-write proof needs.
   *
   * The revocation is watched, not read: the runner's per-run gbrain bearer is
   * recovered from the credential journal gbrain wrote for that client (F7) while
   * the client is still alive, and the SAME string is asserted against gbrain's
   * `/mcp` on both sides of the reclaim — 200 before, 401 after. A stamp alone
   * would not prove anything (`B7` makes the same distinction for the finish
   * path).
   */
  test('C7 killing the runner mid-run reclaims the lease and revokes the run token', async () => {
    C_FIXTURES.push(C_KILL_SCHEDULE);
    await insertAgentPrompt({
      id: C_KILL_SCHEDULE,
      prompt: C_KILL_PROMPT,
      kind: 'interval',
      // The lease is `timeoutSeconds * 1000 + 60s` from the last heartbeat, so a
      // 60s timeout means the reclaim lands ~2 minutes after the kill — long
      // enough to observe the credential alive, short enough to wait for.
      timeoutSeconds: 60,
      budgetUsd: '0.50',
    });
    const responded = await scheduledPost(`/api/schedules/${C_KILL_SCHEDULE}/run-now`, {});
    expect(responded.status).toBe(202);

    const row = await waitFor('the runner to claim the kill fixture', 120_000, async () => {
      const r = (await runsOf(C_KILL_SCHEDULE))[0];
      return r?.state === 'running' ? r : null;
    }, 1_500);
    cObs.killRunId = row.id;
    cObs.killAttemptOneSlot = row.slot;
    expect(row.claimedBy).not.toBeNull();

    // Mid-run: the agent has written its first page and the run is still alive.
    const wrote = await waitFor('the killed attempt to write its first page', 180_000,
      async () => (await spaceHas('internal', `${C_KILL_A}.md`)) ? true : null, 400);
    expect(wrote).toBe(true);
    cObs.killedWritePresent = true;

    expect((await compose('kill', 'agent-runner')).exitCode).toBe(0);
    // Still running when it died: a run that had already finished would make this
    // leg vacuous, so the state is asserted rather than assumed.
    expect((await runRow(cObs.killRunId))!.state).toBe('running');

    const clientId = one(await psql(
      `select coalesce(gbrain_client_id, '') from agent_runs where run_id = '${cObs.killRunId}'`,
    ));
    expect(clientId.length).toBeGreaterThan(0);
    cObs.killClientId = clientId;
    const bearer = await waitFor('the dead run\'s credential journal', 60_000,
      async () => await journalBearer(clientId), 1_000);
    const live = await mcpToolsList(bearer);
    expect(live.status).toBe(200);
    cObs.killBearerLive = live.status;

    // The lease expires on its own clock; the leader's next tick reclaims it.
    const reclaimed = await waitFor('the lease to be reclaimed', 420_000, async () => {
      const r = await runRow(cObs.killRunId);
      return r?.state === 'lease_expired' ? r : null;
    }, 3_000);
    expect(reclaimed.classification).toBe('infra_failed');

    const stored = (await agentRun(cObs.killRunId))!;
    expect(stored.failureClass).toBe('infra_failed');
    expect(stored.tokenRevokedAt).not.toBeNull();
    const failureDetail = JSON.parse(one(await psql(
      `select coalesce(failure_detail::text, 'null') from agent_runs where run_id = '${cObs.killRunId}'`,
    ))) as Record<string, unknown>;
    expect(failureDetail.reason).toBe('lease_expired');
    expect(failureDetail.claimedBy).toBe(row.claimedBy);

    const alerts = await alertsForRun(cObs.killRunId);
    const leaseAlert = alerts.find((a) => a.kind === 'lease_expired');
    expect(leaseAlert).toBeDefined();
    expect(leaseAlert!.detail?.jobType).toBe('agent_prompt');
    expect(leaseAlert!.detail?.claimedBy).toBe(row.claimedBy);
    expect(leaseAlert!.detail?.tokenRevokeError).toBeUndefined();

    // The revocation, by behaviour: the same bearer the reclaim found alive.
    const dead = await mcpToolsList(bearer);
    expect(dead.status).toBe(401);
    expect((await dead.json() as { error?: string }).error).toBe('invalid_token');
    cObs.killBearerDead = dead.status;

    // The lane goes back up; C8 needs it to claim the retry.
    expect((await compose('up', '-d', '--no-deps', '--force-recreate', 'agent-runner')).exitCode).toBe(0);
    const announced = await waitFor('the runner container to come back', 120_000, announcedRunner, 2_000);
    expect(announced.harnessVersion).toBe(HARNESS_PIN);

    console.log(
      `[gate-c] C7 kill mid-run: run=${cObs.killRunId} claimed_by=${row.claimedBy} `
      + `state=${reclaimed.state}/${reclaimed.classification} reason=${String(failureDetail.reason)} `
      + `alert=${leaseAlert!.kind} bearer ${live.status} -> ${dead.status} `
      + `attempt-1 slot=${cObs.killAttemptOneSlot}`,
    );
  }, 900_000);

  /**
   * C8 — the double-write proof, and the one place where the plan and the shipped
   * product disagree.
   *
   * What the plan expects: "after C7's reclaim and one retry, `schedule_runs`
   * holds two rows with attempt 1 and 2". What the shipped product does:
   * `reclaimExpiredLeases` classifies a dead runner's agent run `infra_failed`
   * and revokes its token, and **deliberately does not re-run it** — "the
   * reclaimer classifies; it does not re-run" (its own comment, plus
   * `test/integration/scheduler-claim.test.ts`'s "NEVER auto-retried", and the
   * runbook's alert table). The leg therefore asserts the reclaim's real shape
   * (attempt 1, `lease_expired`, and exactly one row for that slot), and then
   * writes the retry occurrence in the product's own retry shape — `attempt = 2`,
   * `slot = <slot>#r2`, due now, exactly what `createRetryRow` inserts — so that
   * the REAL runner claims it and redoes the SAME work with the same slugs. What
   * that leaves is the roadmap's claim, proven: one copy of each page, not two.
   *
   * The risk material is not hypothetical: C7 measured that the killed attempt's
   * first page was already on disk when it died (untracked, uncommitted — P8's
   * shape), and the retry writes that same path again.
   */
  test('C8 after the reclaim and one retry: one copy of each page, two attempts', async () => {
    expect(cObs.killedWritePresent).toBe(true);

    const reclaimed = (await runsOf(C_KILL_SCHEDULE))!;
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0]!.id).toBe(cObs.killRunId);
    expect(reclaimed[0]!.state).toBe('lease_expired');
    expect(reclaimed[0]!.attempt).toBe(1);

    // The retry occurrence, in `createRetryRow`'s shape.
    const retrySlot = `${cObs.killAttemptOneSlot}#r2`;
    cObs.retryRunId = one(await psql(
      'insert into schedule_runs (id, schedule_id, organization_id, slot, fire_at, state, attempt) '
      + `values (gen_random_uuid(), '${C_KILL_SCHEDULE}', '${fixtureOrgId}', '${retrySlot}', now(), `
      + "'pending', 2) returning id",
    ));
    expect(cObs.retryRunId.length).toBeGreaterThan(20);

    const retryRow = await waitFor('the runner to claim the retry', 180_000, async () => {
      const r = await runRow(cObs.retryRunId);
      return r?.state === 'running' ? r : null;
    }, 1_500);
    expect(retryRow.claimedBy).not.toBeNull();
    expect(retryRow.claimedBy).not.toBe(
      one(await psql(`select claimed_by from schedule_runs where id = '${cObs.killRunId}'`)),
    );

    const done = await waitFor('the retry to finish', 600_000, async () => {
      const r = await runRow(cObs.retryRunId);
      return r && r.state !== 'running' && r.state !== 'pending' ? r : null;
    }, 3_000);
    expect(done.state).toBe('succeeded');

    // Two rows, attempt 1 and 2, distinct slots — and the retry is the SAME work.
    const rows = (await runsOf(C_KILL_SCHEDULE))!;
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.attempt).sort()).toEqual([1, 2]);
    expect(new Set(rows.map((r) => r.slot)).size).toBe(2);
    expect(rows.find((r) => r.attempt === 2)!.slot).toBe(retrySlot);

    // ONE copy of each page: one file, one commit that added it, and the agent's
    // text appearing exactly ONCE in the file it wrote — a retry that appended
    // rather than upserted would show the content twice.
    // Scoped to THIS run's own directory: the basenames repeat across runs, and a
    // repo-wide `find -name` would count an earlier run's page as a duplicate.
    const listing = await opsExec([
      'sh', '-lc', `ls -1 /srv/brain-repos/internal/gate-c/${RUN_ID} 2>/dev/null | sort`,
    ]);
    const names = listing.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const slug of [C_KILL_A, C_KILL_B]) {
      const rel = `${slug}.md`;
      const base = `${slug.split('/').pop()}.md`;
      const marker = slug === C_KILL_A ? `kill-a ${RUN_ID}` : `kill-b ${RUN_ID}`;
      expect(names.filter((n) => n === base).length).toBe(1);
      expect(names).toContain(base);
      const content = await spaceReadFile('internal', rel);
      expect(content).toContain(marker);
      expect(content.split(marker).length - 1).toBe(1);
      const added = await spaceGit('internal', ['log', '--diff-filter=A', '--name-only', '--format=%H', '--', rel]);
      expect(added.stdout.split(/\r?\n/).filter((l) => l.trim() === rel).length).toBe(1);
    }
    const status = await spaceGit('internal', ['status', '--porcelain', '--untracked-files=all']);
    expect(status.stdout.trim()).toBe('');

    console.log(
      `[gate-c] C8 rows=${rows.length} attempts=[${rows.map((r) => r.attempt).join(',')}] `
      + `slots=[${rows.map((r) => r.slot).join(' | ')}] pages=1 copy each `
      + `(${C_KILL_A}.md, ${C_KILL_B}.md) retryRun=${cObs.retryRunId}`,
    );
  }, 900_000);

  /**
   * C9 — exceeding the cap stops the run and alerts, rather than silently
   * truncating it (honesty rule 4). The plan's own words for this leg:
   *
   * > A schedule with a cap below the first call's cost → the gateway refuses
   * > **before forwarding**, the run ends `budget_exceeded`, an alert exists, and
   * > `agent_run_usage` shows zero completed calls — not a truncated one.
   *
   * Which column carries "no upstream connection was opened": `src/gateway/
   * proxy.ts`'s step-1 refusal returns before the forward and writes **no
   * `agent_run_usage` row at all** — there is no column for it, the absence IS
   * the record — while a mid-stream crossing writes a row and marks its alert
   * `midStream: true`. So the leg asserts the absence: a 402 with `tokens: 0` in
   * the gateway's own log line, and a ledger with nothing in it because nothing
   * was forwarded.
   *
   * The cap has to be crossed by spend that ALREADY EXISTS when a call starts.
   * The meter checks `accrued + this call's cost` as the bytes pass
   * (`StreamMeter.observe`, `src/gateway/meter.ts`), so a positive cap the run's
   * FIRST call crosses is caught mid-call by design — `midStream: true`, and a
   * bounded row written — and the pre-forward check only ever fires for a cap the
   * run is already over. A run's first call starts at accrued 0, so the cap that
   * refuses before forwarding, deterministically, is one that cannot fund a call
   * at all.
   *
   * Two windows are therefore excluded. The schedule cannot be CREATED with it:
   * `src/runner/harness.ts` refuses a claim whose budget is not positive ("the
   * meter would refuse the first call anyway"), so the fixture is created
   * claimable at $0.50 while the cap the GATEWAY reads (`agent_runs.budget_usd`,
   * the column `assertBudget` re-reads on every call) is written after the claim
   * and before the harness the runner spawns exists — the claim is what INSERTs
   * `agent_runs` (`src/agent/claim.ts`), and the runner only spawns the harness
   * after a workspace and a pin check (`src/runner/main.ts`). Timing the write off
   * the first METERED CALL — what this leg did before F17 — is not a construction
   * at all: a call's row is written when that call ENDS, so the write raced the
   * harness's next call, and the leg's outcome depended on how many calls the
   * agent happened to make.
   */
  test("C9 a cap below the first call's cost refuses before forwarding, and never truncates", async () => {
    C_FIXTURES.push(C_BUDGET_SCHEDULE);
    // $0.50 is the cap the run is CLAIMED under, and it has to be positive:
    // `src/runner/harness.ts` refuses a claim whose budget is not positive, so a
    // run that cannot fund a call is tightened after the claim (below), never
    // created with it.
    await insertAgentPrompt({
      id: C_BUDGET_SCHEDULE,
      prompt: C_BUDGET_PROMPT,
      kind: 'interval',
      maxTokens: 512,
      budgetUsd: '0.50',
    });
    const responded = await scheduledPost(`/api/schedules/${C_BUDGET_SCHEDULE}/run-now`, {});
    expect(responded.status).toBe(202);

    // The cap goes below the first call's cost in the one window where the
    // ordering is the runner's own sequence rather than a guess. `claimAgentRun`
    // INSERTs `agent_runs` (src/agent/claim.ts) before its response reaches the
    // runner, so a row that exists IS the claim; the harness that will make the
    // first call does not exist until the runner has read that response, made a
    // workspace, verified the pin and spawned it — and its first
    // `POST /v1/messages` was measured 0.7-0.8s after the spawn. This poll's
    // round trip is ~145ms, so the cap is on the row before anything can read it.
    //
    // Detection and write are ONE statement, so there is no window between them,
    // and `budget_usd = '0.50'` keeps it to this leg's run.
    const cap = '0';
    const postgres = one((await compose('ps', '-q', 'postgres')).stdout.trim());
    expect(postgres).not.toBe('');
    const runId = await waitFor('the claimed run to be capped below a call', 180_000, async () => {
      const got = one(await psqlIn(
        postgres,
        `update agent_runs a set budget_usd = '${cap}' `
        + `where a.budget_usd = '0.50' and exists (select 1 from schedule_runs r `
        + `where r.id = a.run_id and r.schedule_id = '${C_BUDGET_SCHEDULE}') `
        + 'returning a.run_id',
      ));
      return got === '' || got.startsWith('UPDATE ') ? null : got;
    }, 25);
    cObs.budgetRunId = runId;

    const ended = await waitFor('the run to end budget_exceeded', 420_000, async () => {
      const r = await runRow(runId);
      return r && r.state !== 'running' && r.state !== 'pending' ? r : null;
    }, 2_000);
    expect(ended.state).toBe('failed');
    expect(ended.classification).toBe('budget_exceeded');

    const stored = (await agentRun(runId))!;
    expect(stored.failureClass).toBe('budget_exceeded');
    const detail = JSON.parse(one(await psql(
      `select coalesce(failure_detail::text, 'null') from agent_runs where run_id = '${runId}'`,
    ))) as Record<string, unknown>;
    // The reason the FINISH path records. `finishAgentRun` rewrites
    // `failure_detail` for a run whose class a component already recorded, so the
    // row says `recorded_by_component` while the class it kept is the meter's —
    // and the meter's own numbers live on the ALERT it raised at the refusal.
    expect(detail.reason).toBe('recorded_by_component');
    // The class is the meter's, not the harness's symptom: the run ended
    // `budget_exceeded` rather than `agent_failed` for the 402 the harness saw.
    expect(stored.failureClass).toBe('budget_exceeded');

    const alerts = await alertsForRun(runId);
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.kind).toBe('agent_budget_exceeded');
    expect(alerts[0]!.detail?.reason).toBe('budget_exceeded');
    expect(Number(alerts[0]!.detail?.budgetUsd)).toBe(Number(cap));
    // `accruedCost` is 0 over zero rows — nothing spent is a known amount.
    expect(Number(alerts[0]!.detail?.accruedUsd)).toBe(0);
    // The meter's own discriminator: a mid-stream crossing records `midStream`.
    expect(alerts[0]!.detail?.midStream).toBeUndefined();

    // The gateway's own log lines: the refusal — status 402 with `tokens: 0`, i.e.
    // it closed the exchange before any upstream usage existed — and NO forwarded
    // exchange at all. A mid-stream crossing would log the tokens it had metered.
    const lines = await gatewayLines(runId);
    const forwarded = lines.filter((l) => typeof l.status === 'number' && l.status >= 200 && l.status < 300);
    const refused = lines.filter((l) => l.status === 402);
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused.every((l) => l.tokens === 0 && l.costUsd === null)).toBe(true);
    expect(forwarded.length).toBe(0);

    // "agent_run_usage shows zero completed calls — not a truncated one": the
    // count is derived from the gateway's own record (one row per FORWARDED call,
    // and nothing for a refusal), and both sides are zero — the ledger's emptiness
    // is the gateway's own statement that it forwarded nothing, so it cannot be
    // satisfied by a truncated row the crossing would have written.
    const usage = await usageRows(runId);
    expect(usage.length).toBe(forwarded.length);
    expect(usage.length).toBe(0);

    console.log(
      `[gate-c] C9 cap=$${cap} (schedule 0.50) accrued=$0 -> classification=`
      + `${ended.classification} alert=${alerts[0]!.kind} gateway=402/tokens:0 `
      + `forwarded=${forwarded.length} usage rows=${usage.length} (no row, no midStream)`,
    );
  }, 600_000);

  /**
   * C10 — the fence, proven from INSIDE the running container (honesty rule 2).
   *
   * Nothing here reads the compose file: the probes execute in the runner's own
   * network namespace, and the assertions are about their results. Two hosts must
   * answer (the control plane it long-polls and Caddy, which fronts the MCP
   * endpoint) and everything else — a sibling compose service, an external IP, an
   * external name — must fail. The absence of a default route is read from the
   * kernel's own table, and it is only meaningful because the table is not empty:
   * the runner-net subnet is there, and `/proc/net/route` carries no `00000000`
   * destination.
   */
  test('C10 the fence: only Caddy and the control plane answer, and there is no default route', async () => {
    const code = `
      const probe = async (host, port) => {
        const { promise, reject } = Promise.withResolvers();
        const timer = setTimeout(() => reject(new Error('timeout')), 4000);
        try {
          const sock = await Promise.race([
            Bun.connect({ hostname: host, port, socket: { data() {}, open() {}, error() {} } }),
            promise,
          ]);
          sock.end();
          return 'connected';
        } catch (e) { return 'failed:' + (e && (e.code || e.message) || String(e)); }
        finally { clearTimeout(timer); }
      };
      const hosts = [
        ['control-plane', 3150], ['caddy', 443],
        ['localhost', 443], ['postgres', 5432], ['gbrain-serve', 3131],
        ['gbrain-ops', 3140], ['1.1.1.1', 443], ['api.anthropic.com', 443],
      ];
      const out = {};
      for (const [h, p] of hosts) out[h + ':' + p] = await probe(h, p);
      console.log(JSON.stringify(out));
    `;
    const probes = await runnerExec(['bun', '-e', code], 120_000);
    expect(probes.exitCode).toBe(0);
    const results = JSON.parse(probes.stdout.trim().split(/\r?\n/).pop()!) as Record<string, string>;

    expect(results['control-plane:3150']).toBe('connected');
    expect(results['caddy:443']).toBe('connected');
    for (const denied of [
      'localhost:443', 'postgres:5432', 'gbrain-serve:3131', 'gbrain-ops:3140',
      '1.1.1.1:443', 'api.anthropic.com:443',
    ]) {
      expect(results[denied]).toMatch(/^failed:/);
    }

    const route = await runnerExec(['sh', '-lc', 'cat /proc/net/route'], 60_000);
    expect(route.exitCode).toBe(0);
    const rows = route.stdout.split(/\r?\n/).slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => f.length > 2 && f[0] !== '');
    expect(rows.length).toBeGreaterThan(0);           // the probe can see a table
    for (const f of rows) {
      expect(f[1]).not.toBe('00000000');              // no default destination
      expect(f[2]).toBe('00000000');                  // and no gateway to leave by
    }

    console.log(
      `[gate-c] C10 from inside agent-runner: control-plane=${results['control-plane:3150']} `
      + `caddy=${results['caddy:443']} denied=[`
      + ['localhost:443', 'postgres:5432', 'gbrain-serve:3131', 'gbrain-ops:3140', '1.1.1.1:443', 'api.anthropic.com:443']
        .map((h) => `${h}=${results[h]}`).join(' ') + '] '
      + `routes=[${rows.map((f) => f[1] + '/' + f[3]).join(',')}] (no 00000000 default)`,
    );
  }, 300_000);

  /**
   * C11 — a prompt that asks for Bash yields no execution.
   *
   * The surface is what the harness itself reports, not what the flags say: the
   * `system/init` event carries the tool list the child was given, so the leg
   * asserts on the receipt. "Nothing ran" is asserted the same way: no `tool_use`
   * anywhere but the MCP ones, and the write Space's head unmoved with no
   * uncommitted leftovers — a shell command would have had to leave one.
   */
  test('C11 a prompt that asks for Bash produces no execution', async () => {
    C_FIXTURES.push(C_BASH_SCHEDULE);
    await insertAgentPrompt({
      id: C_BASH_SCHEDULE,
      prompt: C_BASH_PROMPT,
      kind: 'interval',
      maxTokens: 256,
      budgetUsd: '0.50',
    });
    const responded = await scheduledPost(`/api/schedules/${C_BASH_SCHEDULE}/run-now`, {});
    expect(responded.status).toBe(202);

    const row = await waitFor('the runner to claim the bash fixture', 120_000, async () => {
      const r = (await runsOf(C_BASH_SCHEDULE))[0];
      return r?.state === 'running' ? r : null;
    }, 1_500);
    cObs.bashRunId = row.id;
    const ended = await waitFor('the bash run to finish', 420_000, async () => {
      const r = await runRow(row.id);
      return r && r.state !== 'running' && r.state !== 'pending' ? r : null;
    }, 2_000);
    expect(ended.state).toBe('succeeded');

    const events = await eventRows(row.id);
    const uses = toolUsesOf(events);
    // The tool list the child was actually given: MCP only, and non-empty.
    const init = events.find((e) => e.kind === 'system/init');
    const tools = ((init?.data as { tools?: unknown } | null)?.tools ?? []) as unknown[];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => typeof t === 'string' && t.startsWith('mcp__gbrain__'))).toBe(true);
    expect(tools.some((t) => t === 'Bash')).toBe(false);

    // Nothing ran: no Bash tool call, no tool result that is not an MCP tool's.
    expect(uses.some((u) => u.name === 'Bash')).toBe(false);
    expect(uses.every((u) => u.name.startsWith('mcp__gbrain__'))).toBe(true);
    const resultFrame = events.find((e) => e.kind === 'result');
    const denials = ((resultFrame?.data as { permission_denials?: unknown } | null)?.permission_denials ?? []);
    cObs.bashDenials = denials;
    if (Array.isArray(denials) && denials.length > 0) {
      // The harness denied something: it must be a tool the fence refused, never
      // an MCP tool this run was granted.
      const names = denials.map((d) => String((d as { tool_name?: unknown })?.tool_name ?? d));
      expect(names.every((n) => !n.startsWith('mcp__gbrain__'))).toBe(true);
    } else {
      // No denial was recorded, because there was no tool to deny: the surface is
      // MCP-only (asserted above). The run still left the brain untouched.
      expect(denials).toEqual([]);
    }

    // Nothing ran, in the brain: the write Space did not move and carries no
    // uncommitted work a shell command could have produced.
    const heads = JSON.parse(one(await psql(
      "select json_build_object('before',heads_before,'after',heads_after)::text "
      + `from agent_runs where run_id = '${row.id}'`,
    ))) as { before: Record<string, string>; after: Record<string, string> };
    expect(heads.after.internal).toBe(heads.before.internal);
    const status = await spaceGit('internal', ['status', '--porcelain', '--untracked-files=all']);
    expect(status.stdout.trim()).toBe('');
    const diff = JSON.parse(one(await psql(
      `select coalesce(diff_summary::text, 'null') from agent_runs where run_id = '${row.id}'`,
    ))) as { write: { files: unknown[] } } | null;
    expect(diff?.write.files ?? []).toEqual([]);

    console.log(
      `[gate-c] C11 bash prompt: surface=[${tools.join(',')}] toolUses=[${uses.map((u) => u.name).join(',') || 'none'}] `
      + `permission_denials=${JSON.stringify(denials)} writeSpace head unmoved `
      + `(${heads.before.internal!.slice(0, 8)})`,
    );
  }, 600_000);

  /**
   * C12 — the runner is optional (D12), proven with B10's own technique rather
   * than a second one: the profile's container is stopped and the control plane is
   * recreated with an EMPTY `RUNNER_TOKEN`, which is what a default `up` (no
   * `runner` profile) boots with. The stack must still be healthy, `/api/health`
   * must say `disabled` (honesty rule 8's third state), and enabling an
   * `agent_prompt` schedule must be refused — with no row written.
   *
   * It ends by restoring the lane and asserting it is genuinely polling again,
   * because the gate must leave exactly the state the NEXT consecutive run starts
   * from.
   */
  test('C12 a default up leaves the stack healthy and refuses agent work', async () => {
    expect((await compose('stop', 'agent-runner')).exitCode).toBe(0);
    const down = await composeWith({ RUNNER_TOKEN: '' }, 'up', '-d', '--force-recreate', 'control-plane');
    expect(down.exitCode).toBe(0);

    const health = await waitForHealth(
      (h) => h.runner.state === 'disabled', 180_000, 'the lane to report disabled',
    );
    expect(health.ok).toBe(true);
    expect(health.components.controlDb).toBe('ok');
    expect(health.components.ops).toBe('ok');
    expect(health.pin.matches).toBe(true);
    expect(health.runner.lastSeenAt).toBeNull();
    const reserved = await fetchInsecure('/.well-known/gbrain');
    expect(reserved.status).toBe(200);

    const name = `gate-c-no-runner-${RUN_ID}`;
    const refused = await scheduledPost('/api/schedules', {
      ...AGENT_PAYLOAD, connectionId: fixtureConnectionId, name,
    });
    expect(refused.status).toBe(409);
    const body = await readJson<{ error: string; state: string }>(refused, 'create while disabled');
    expect(body.error).toBe('runner_not_enabled');
    expect(body.state).toBe('disabled');
    expect(one(await psql(`select count(*) from schedules where name = '${name}'`))).toBe('0');

    // Restore: the real configuration, and a runner that is really polling.
    expect((await composeWith({}, 'up', '-d', '--force-recreate', 'control-plane')).exitCode).toBe(0);
    expect((await compose('up', '-d', '--no-deps', '--force-recreate', 'agent-runner')).exitCode).toBe(0);
    const restored = await waitForHealth(
      (h) => h.runner.state !== 'disabled', 180_000, 'the lane to come back',
    );
    const announced = await waitFor('the runner container to be up again', 120_000, announcedRunner, 2_000);
    expect(announced.harnessVersion).toBe(HARNESS_PIN);
    // Polling the CURRENT control plane, not the address it was recreated behind
    // (F14's trap): a claim with no runner id is answered by the route itself.
    const shape = await fetchInsecure('/api/runs/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${runnerToken()}` },
      body: JSON.stringify({ harnessVersion: HARNESS_PIN }),
    });
    expect(shape.status).toBe(400);
    expect((await readJson<{ error: string }>(shape, 'left-enabled shape refusal')).error)
      .toBe('runner_never_seen');

    console.log(
      `[gate-c] C12 disabled: ${JSON.stringify(health.runner)} ok=${health.ok} `
      + `create=409/runner_not_enabled; restored: runner=${JSON.stringify(restored.runner)} `
      + `container=${announced.id}`,
    );
  }, 600_000);

  /**
   * The state Gate C leaves: no Gate C fixtures, a clean write Space, and the
   * lane enabled — the same state the SECOND consecutive run of the whole
   * directory has to start from (the plan's closing condition).
   */
  afterAll(async () => {
    if (!dockerAvailable) return;
    // The gate's own money, read BEFORE the fixtures (and their cascading runs)
    // are deleted: per-run cost, the four token counts and the metered call count,
    // so the findings entry carries measured numbers rather than an estimate.
    const spend = JSON.parse(await psql(
      "select coalesce(json_agg(json_build_object('schedule',r.schedule_id,'run',a.run_id,"
      + "'state',r.state,'class',r.classification,'cost',a.cost_usd,'attempt',r.attempt,"
      + "'in',a.input_tokens,'out',a.output_tokens,'cacheRead',a.cache_read_tokens,"
      + "'cacheWrite',a.cache_write_tokens,"
      + "'calls',(select count(*) from agent_run_usage u where u.run_id = a.run_id)) "
      + "order by r.created_at), '[]'::json) from agent_runs a join schedule_runs r on r.id = a.run_id "
      + `where r.schedule_id like 'gate-c-%'`,
    )) as Array<Record<string, unknown>>;
    let gateTotal = 0;
    for (const row of spend) {
      gateTotal += Number(row.cost ?? 0);
      console.log(`[gate-c] spend ${JSON.stringify(row)}`);
    }
    console.log(`[gate-c] Gate C total model spend = $${gateTotal.toFixed(7)} over ${spend.length} run(s)`);
    for (const id of C_FIXTURES) {
      await deleteScheduleFixture(id).catch(() => { /* never mask the run's own failure */ });
    }
    // The retry row C8 wrote is inside the kill schedule and cascades with it.
    expect(one(await psql(
      `select count(*) from schedules where id like 'gate-c-%${RUN_ID}%'`,
    ))).toBe('0');
    const leftovers = await spaceGit('internal', ['status', '--porcelain', '--untracked-files=all']);
    expect(leftovers.stdout.trim()).toBe('');
    const health = await waitForHealth(
      (h) => h.runner.state !== 'disabled', 180_000, 'the lane to be left enabled',
    );
    expect(health.runner.state).not.toBe('disabled');
    console.log(
      `[gate-c] teardown: ${C_FIXTURES.length} fixture schedules deleted, write Space clean, `
      + `runner=${JSON.stringify(health.runner)}`,
    );
  }, 600_000);
});
