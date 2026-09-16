// ---------------------------------------------------------------------------
// Slice 3 — Seam Gate B (Task 17). Task 18 appends `describe('Slice 3 seam gate
// C')` to THIS file and reuses every helper below: the sign-in / TLS / JSON
// harness, the MAIN-stack exec helper, the run-state poller, and the exported
// module-level `connection` / `writeSpace` / `scheduleId` bindings B1-B4 resolve.
//
// Gate B drives the real product stack over HTTP (https://localhost:8443) and
// the real ops RPC behind it. B8 is the one that matters most: the whole lane —
// HTTP -> control plane -> scheduler DB -> worker claim -> ops RPC ->
// `gbrain sync --source shared` -> report write -> git commit as the member.
//
// Harness rules it inherits (all load-bearing):
//   L4/L5  never `docker compose down -v`; reuse Slice 2's Spaces and an
//          existing active Connection (no new Space is created here).
//   L8     the harness restarts `control-plane` + `gbrain-serve` (the rate
//          limiters) between runs — never the volumes.
//   L7     no wall-clock assertion tighter than 2s per probe: assert DB state
//          and file state, never latency.
// ---------------------------------------------------------------------------
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { closeDb, getDb, pinDb, schema } from '../../src/control/db/client.ts';
// Gate C (Task 18) calls the SHIPPED scheduler paths with an injected clock:
// only `now` is a parameter, so the DST / catch-up / overlap behaviour it
// asserts is the production one, against the production schema.
import { claimNextRun, finishRun } from '../../src/scheduler/claim.ts';
import { withLeadership } from '../../src/scheduler/leader.ts';
import { materializeDue } from '../../src/scheduler/materialize.ts';

const SKIP_SLICE3_E2E_ENV = 'BRAINSTAND_ALLOW_SKIP_SLICE3_E2E';

const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8443';
const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PASSWORD = 'a-long-enough-password';
const RUN_ID = Date.now().toString(36);
/** Slice 2's write Space for the adopted Connection, and B8's report home. */
const WRITE_SPACE = 'shared';
/** The job name B4 gives the schedule — it is also the `reports/<job>/` dir. */
const LIVE_SYNC_NAME = 'live-sync';
/** Terminal run states. Anything else means the scheduler never finished it. */
const TERMINAL_STATES = [
  'succeeded', 'failed', 'held', 'cancelled',
  'lease_expired', 'skipped_overlap', 'skipped_catchup',
];

// Dummy interpolation only — compose still parses ${VAR:?required} even against
// an already-up project. Real CI/env values win when set.
const COMPOSE_ENV: Record<string, string> = {
  ...process.env as Record<string, string>,
  DOMAIN: process.env.DOMAIN ?? 'localhost',
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? 'change-me-in-a-real-deployment',
  OPS_RPC_TOKEN: process.env.OPS_RPC_TOKEN ?? 'compose-exec-placeholder',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? 'compose-exec-placeholder-32-characters',
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'compose-exec-placeholder-32-characters',
};

/** The MAIN product stack — never the slice0 harness project `composeExec` targets. */
const STACK = [
  ...(existsSync('.env') ? ['--env-file', '.env'] as const : []),
  '-f', 'compose/docker-compose.yml',
  '-f', 'compose/docker-compose.dev.yml',
];

const COMPOSE = ['docker', 'compose', ...STACK];

export const fetchInsecure = (path: string, init?: RequestInit) =>
  fetch(`${BASE}${path}`, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);

const compose = (...args: string[]) =>
  Bun.spawn([...COMPOSE, ...args], {
    stdout: 'pipe', stderr: 'pipe', env: COMPOSE_ENV,
  }).exited;

/**
 * Exec inside the MAIN stack's `gbrain-ops` — where the Spaces, the reports and
 * the git repos actually live. `Bun.$` with an ARRAY keeps every element its own
 * argv entry (no shell string, ever); `.nothrow()` keeps a non-zero exit
 * inspectable instead of throwing.
 */
export async function mainExec(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const r = await Bun.$`docker compose ${STACK} exec -T gbrain-ops ${argv}`.quiet().nothrow();
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

async function probeDockerCompose(): Promise<boolean> {
  try {
    return (await Bun.$`docker compose version`.quiet().nothrow()).exitCode === 0;
  } catch {
    return false;
  }
}

const dockerAvailable = await probeDockerCompose();

// --- fixture shapes ---------------------------------------------------------

export type SpaceRow = { id: string; sourceId: string; name: string };
type MemberRoleRow = { membershipId: string; email: string; role: string };
export type ConnectionRow = {
  id: string;
  membershipId: string;
  writeSpaceId: string;
  state: string;
  clientName: string;
  gbrainClientId: string | null;
};
type ScheduleRow = {
  id: string;
  name: string;
  preset: string | null;
  operation: string;
  kind: string;
  enabled: boolean;
  disabledReason: string | null;
  intervalSeconds: number | null;
  connectionId: string | null;
};
export type RunRow = {
  id: string;
  slot: string;
  fireAt: string;
  state: string;
  exitCode: number | null;
  classification: string | null;
  reportPath: string | null;
  summary: { changed?: number | null; status?: string | null; error?: string; released?: number } | null;
};
type AlertRow = { id: string; kind: string; scheduleId: string | null; acknowledgedAt: string | null; detail?: unknown };
type Overview = { spaces: SpaceRow[]; members: MemberRoleRow[] };

// --- state Gate C reads -----------------------------------------------------

export let cookie = '';
export let connection!: ConnectionRow;
export let writeSpace!: SpaceRow;
export let scheduleId = '';
let spacesBySource: Record<string, SpaceRow> = {};
/** B10's throwaway Connection + its schedule, left in place for Task 18. */
export let throwawayConnectionId = '';
export let throwawayScheduleId = '';

export function jsonHeaders(extra: Record<string, string> = {}) {
  return { 'content-type': 'application/json', cookie, ...extra };
}

export function post(path: string, body: unknown) {
  return fetchInsecure(path, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
}

export function patch(path: string, body: unknown) {
  return fetchInsecure(path, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(body) });
}

export function get(path: string) {
  return fetchInsecure(path, { headers: { cookie } });
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

function harvestCookie(res: Response): string {
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') ?? ''];
  return setCookies.filter(Boolean).map((c) => c.split(';')[0]!).join('; ');
}

async function waitForHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string = 'no response';
  // Real wall-clock polling, deliberately: readiness belongs to OTHER processes
  // (caddy, control-plane, gbrain-ops) and cannot be advanced by a fake clock.
  while (Date.now() < deadline) {
    try {
      const res = await fetchInsecure('/api/health');
      last = `${res.status} ${(await res.text()).slice(0, 200)}`;
      if (res.status === 200) return;
    } catch (e) { last = e instanceof Error ? e.message : String(e); }
    await Bun.sleep(2_000);
  }
  throw new Error(`the stack never reported healthy within ${timeoutMs}ms (last: ${last})`);
}

/** Poll one schedule's history until its newest run finishes, then return it. */
export async function waitForRunState(
  id: string, wanted: readonly string[], timeoutMs: number,
): Promise<RunRow> {
  const deadline = Date.now() + timeoutMs;
  let last: RunRow | null = null;
  // The scheduler service ticks on its own 15s wall clock in another container;
  // no fake clock can advance it, so the poll is real and only its DEADLINE is
  // bounded (L7: never assert the wall clock, assert the state it produces).
  while (Date.now() < deadline) {
    const body = await readJson<{ runs: RunRow[] }>(await get(`/api/schedules/${id}/runs`), 'GET runs');
    last = body.runs[0] ?? null;
    if (last && wanted.includes(last.state)) return last;
    await Bun.sleep(2_000);
  }
  throw new Error(
    `schedule ${id} produced no run in ${wanted.join('/')} within ${timeoutMs}ms `
    + `(last: ${JSON.stringify(last)})`,
  );
}

/** Gate C's precondition: Gate B ran for real, against a real Connection. */
export function requireGateBReady(): void {
  if (!cookie) throw new Error('Gate C needs the admin cookie from Gate B (B1)');
  if (!scheduleId) throw new Error('Gate C needs the live-sync schedule from Gate B (B4)');
  if (!connection?.id) throw new Error('Gate C needs the adopted Connection from Gate B (B1)');
}

/** The schedules THIS gate creates. A name is unique per org, so a repeat run
 *  would 409 `name_taken` before reaching an assertion (L8: repeat runs are the
 *  norm). Everything the console agent left behind is `console-*` and stays. */
const GATE_SCHEDULE_NAMES = [
  LIVE_SYNC_NAME, 'nightly-dream', 'gate-b-throwaway',
  // Gate C's own two calendar fixtures (C4).
  'gate-c-nightly', 'gate-c-ambiguous',
];

async function prunePreviousGateSchedules(): Promise<void> {
  const { schedules } = await readJson<{ schedules: ScheduleRow[] }>(
    await get('/api/schedules'), 'GET /api/schedules',
  );
  for (const s of schedules) {
    if (!GATE_SCHEDULE_NAMES.includes(s.name)) continue;
    // Disable + rename, never delete — the same reason `revokeConnection`
    // disables instead of deleting. A delete would cascade the run rows away
    // and null the alert rows that point at this schedule.
    const res = await patch(`/api/schedules/${s.id}`, {
      enabled: false, name: `${s.name}-old-${RUN_ID}`,
    });
    if (res.status !== 200) {
      throw new Error(`could not retire the previous run's ${s.name}: ${res.status} ${await res.text()}`);
    }
  }
}

/**
 * A report is written `on_change_or_failure` (the live-sync default), so the
 * Space must have something for `sync --source shared` to import — otherwise a
 * repeat run legitimately writes no report and the whole report half of B8
 * would be skipped. Gate A seeds its probe source for the same reason.
 */
async function seedWriteSpaceCommit(): Promise<string> {
  const file = `gate-b-seed-${RUN_ID}.md`;
  const repo = `/srv/brain-repos/${WRITE_SPACE}`;
  const r = await mainExec(['sh', '-c',
    `set -e; cd ${repo}; `
    + `printf '# gate b seed\\n\\nSeeded by the slice3 e2e gate ${RUN_ID}.\\n' > ${file}; `
    + `git add ${file}; `
    + `git -c user.email=gate-b@brainstand.local -c user.name=gate-b commit -qm "gate-b seed ${RUN_ID}"`,
  ]);
  if (r.exitCode !== 0) throw new Error(`seed commit failed: ${r.stderr || r.stdout}`);
  return file;
}

/**
 * L8: claim is 20 hits / 15 min in process, so the gate ADOPTS an active
 * Connection and only mints one when there is none to adopt.
 */
async function claimFreshConnection(member: MemberRoleRow, space: SpaceRow): Promise<ConnectionRow> {
  const created = await post('/api/connections', {
    membershipId: member.membershipId,
    writeSpaceId: space.id,
    readSpaceIds: [space.id],
    harness: 'generic',
  });
  expect(created.status).toBe(200);
  const mintedConn = await readJson<{ id: string }>(created, 'POST /api/connections');

  const minted = await post(`/api/members/${member.membershipId}/claim-link`, {});
  expect(minted.status).toBe(200);
  const { token } = await readJson<{ token: string }>(minted, 'POST claim-link');

  const claimed = await fetchInsecure(`/api/claim/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: member.email }),
  });
  expect(claimed.status).toBe(200);
  const body = await readJson<{ connections: Array<{ connectionId: string }> }>(claimed, 'POST /api/claim/:token');
  expect(body.connections.map((c) => c.connectionId)).toContain(mintedConn.id);

  const list = await readJson<{ connections: ConnectionRow[] }>(await get('/api/connections'), 'GET /api/connections');
  const row = list.connections.find((c) => c.id === mintedConn.id);
  if (!row) throw new Error(`claimed connection ${mintedConn.id} vanished from /api/connections`);
  return row;
}

beforeAll(async () => {
  if (!dockerAvailable) return;
  let reachable = true;
  try { await fetchInsecure('/api/health'); } catch { reachable = false; }
  if (!reachable) {
    await compose('up', '-d', '--wait');
  }
  await waitForHealthy(300_000);
  // L8, not L4: repeat runs need fresh rate-limit windows, NOT fresh volumes.
  await compose('restart', 'control-plane', 'gbrain-serve');
  await waitForHealthy(300_000);
}, 1_800_000);

describe('Slice 3 seam gate B', () => {
  test('slice3 e2e tests are not silently skipped', () => {
    if (dockerAvailable) return;
    if (process.env[SKIP_SLICE3_E2E_ENV] === '1') return;
    throw new Error(
      'docker compose is not usable, so the slice3 e2e suite was skipped rather than run. '
        + 'Install/start Docker, then rerun:\n\n'
        + '  bun test --parallel=1 test/e2e/slice3.e2e.test.ts\n\n'
        + `If skipping is genuinely intended for this run, set ${SKIP_SLICE3_E2E_ENV}=1 `
        + 'to acknowledge it explicitly.',
    );
  });

  test.skipIf(!dockerAvailable)('B1. sign in and adopt an existing active Connection', async () => {
    const boot = await fetchInsecure('/api/bootstrap', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, orgName: 'Acme' }),
    });
    expect([200, 409]).toContain(boot.status);

    const signIn = await fetchInsecure('/api/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(signIn.status).toBe(200);
    cookie = harvestCookie(signIn);
    expect(cookie.length).toBeGreaterThan(0);

    const overview = await readJson<Overview>(await get('/api/access-overview'), 'GET /api/access-overview');
    spacesBySource = Object.fromEntries(overview.spaces.map((s) => [s.sourceId, s]));
    writeSpace = spacesBySource[WRITE_SPACE]!;
    expect(writeSpace?.id).toBeTruthy();

    const list = await readJson<{ connections: ConnectionRow[] }>(
      await get('/api/connections'), 'GET /api/connections',
    );
    const active = list.connections.filter(
      (c) => c.state === 'active' && c.writeSpaceId === writeSpace.id,
    );
    if (active.length > 0) {
      connection = active[0]!;
    } else {
      const member = overview.members.find((m) => m.role === 'member');
      if (!member) throw new Error('no member membership on this stack — the gate cannot claim a Connection');
      connection = await claimFreshConnection(member, writeSpace);
    }

    expect(connection.state).toBe('active');
    expect(writeSpace.sourceId).toBe('shared');

    // A repeat run must reach its assertions, not 409 on last run's fixtures.
    await prunePreviousGateSchedules();
  }, 300_000);

  test.skipIf(!dockerAvailable)('B2. set the org timezone and quiet hours', async () => {
    const res = await patch('/api/org/schedule-settings', {
      timezone: 'America/New_York', quietHoursStart: 23, quietHoursEnd: 8,
    });
    expect(res.status).toBe(200);
    expect(await readJson<{ settings: Record<string, unknown> }>(res, 'PATCH /api/org/schedule-settings'))
      .toMatchObject({ settings: { timezone: 'America/New_York', quietHoursStart: 23, quietHoursEnd: 8 } });

    // A fixed-offset alias is not an IANA zone: every wall-clock decision the
    // scheduler makes (DST, slots, quiet hours) assumes a real one.
    const refused = await patch('/api/org/schedule-settings', { timezone: 'EST' });
    expect(refused.status).toBe(400);
    expect((await readJson<{ error: string }>(refused, 'PATCH EST')).error).toBe('invalid_timezone');
  });

  test.skipIf(!dockerAvailable)("B3. presets list includes three user presets and the org's system ones", async () => {
    const body = await readJson<{ presets: Array<{ id: string; system?: true }>; system: string[] }>(
      await get('/api/schedule-presets'), 'GET /api/schedule-presets',
    );
    expect(body.presets.filter((p) => !p.system).map((p) => p.id).sort())
      .toEqual(['live-sync', 'nightly-dream', 'weekly-health']);
    for (const id of body.system) {
      expect(body.presets.find((p) => p.id === id)?.system).toBe(true);
    }
  });

  test.skipIf(!dockerAvailable)('B4. create a live-sync schedule at 5 minutes on the Connection', async () => {
    const res = await post('/api/schedules', {
      name: LIVE_SYNC_NAME, preset: 'live-sync', connectionId: connection.id,
      operation: 'sync', kind: 'interval', intervalSeconds: 300, params: {},
    });
    expect(res.status).toBe(201);
    const body = await readJson<ScheduleRow>(res, 'POST /api/schedules');
    scheduleId = body.id;
    expect(scheduleId).toBeTruthy();
    expect(body.kind).toBe('interval');
    expect(body.intervalSeconds).toBe(300);
    expect(body.enabled).toBe(true);
    expect(body.connectionId).toBe(connection.id);
  });

  test.skipIf(!dockerAvailable)('B5. a second sub-hourly schedule is refused with the reason', async () => {
    const res = await post('/api/schedules', {
      name: 'live-sync-2', connectionId: connection.id,
      operation: 'embed', kind: 'interval', intervalSeconds: 600, params: { stale: true },
    });
    expect(res.status).toBe(409);
    const body = await readJson<{ error: string; holder?: string }>(res, 'POST second sub-hourly');
    expect(body.error).toBe('sub_hourly_limit');
    // The 409 names the schedule holding the lane — the console renders that.
    expect(body.holder).toBe(LIVE_SYNC_NAME);
  });

  test.skipIf(!dockerAvailable)('B6. a calendar collision is refused WITH the next free slot', async () => {
    const calendarBody = (name: string) => ({
      name, preset: 'nightly-dream', connectionId: connection.id,
      operation: 'dream', kind: 'calendar', calendarHour: 2, calendarMinute: 5,
      params: { maxUsd: 5, yes: true },
    });

    const first = await post('/api/schedules', calendarBody('nightly-dream'));
    expect(first.status).toBe(201);

    const res = await post('/api/schedules', calendarBody('another-nightly'));
    expect(res.status).toBe(409);
    expect(await readJson<{ error: string; nextFree: number }>(res, 'POST colliding calendar'))
      .toMatchObject({ error: 'slot_taken', nextFree: 10 });
  });

  test.skipIf(!dockerAvailable)('B7. a fenced param in the request body is refused', async () => {
    const res = await post('/api/schedules', {
      name: 'fence-probe', connectionId: connection.id, operation: 'sync',
      kind: 'interval', intervalSeconds: 3600, params: { source: 'internal' },
    });
    expect(res.status).toBe(400);
    expect((await readJson<{ error: string }>(res, 'POST fenced param')).error).toMatch(/fenced/);
  });

  test.skipIf(!dockerAvailable)('B8. run-now executes for real: sync runs, a report lands, git records it', async () => {
    // A live-sync run has to have something to import to prove the lane read the
    // Space at all, so the gate commits one page first (Gate A seeds likewise).
    await seedWriteSpaceCommit();

    const res = await post(`/api/schedules/${scheduleId}/run-now`, {});
    expect(res.status).toBe(202);
    const run = await waitForRunState(scheduleId, TERMINAL_STATES, 300_000);
    expect(run.state).toBe('succeeded');
    expect(run.classification).toBe('ok');
    expect(run.exitCode).toBe(0);

    // The report half: a missing report is a FAILURE here, never a skipped
    // check — a gate that skips its own evidence proves nothing.
    expect(run.reportPath).toBeTruthy();
    const cat = await mainExec(['cat', `/srv/brain-repos/${WRITE_SPACE}/${run.reportPath}`]);
    expect(cat.exitCode).toBe(0);
    expect(cat.stdout).toContain('Write Space: `shared`');
    // The --source fence came from the Connection, not from the request.
    expect(cat.stdout).toContain(`gbrain sync --source ${WRITE_SPACE} --json`);
    // ... and it really did import: the receipt the report carries says so.
    expect(cat.stdout).toContain('"sync_status":"synced"');
    // Honesty rule 1 in the artifact the member reads: the Connection is OUR
    // argv fence, not a gbrain-enforced OAuth scope.
    expect(cat.stdout).toContain('not a permission gbrain enforces');
    // S3c: no credential ever reaches a committed report.
    expect(cat.stdout).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(cat.stdout).not.toMatch(/postgres(ql)?:\/\/[^:]+:[^@]+@/);

    // Committed, and the tree is clean: sync imports commits, so an
    // uncommitted report is a page the brain cannot see.
    const log = await mainExec(['git', '-C', `/srv/brain-repos/${WRITE_SPACE}`, 'log', '-1', '--format=%s']);
    expect(log.stdout).toContain(`reports: ${LIVE_SYNC_NAME}`);
    const status = await mainExec(['git', '-C', `/srv/brain-repos/${WRITE_SPACE}`, 'status', '--porcelain']);
    expect(status.stdout.trim()).toBe('');

    // The run's own summary carries the receipt's status — which is only true
    // if the ops RPC handed the scheduler a parsed receipt, not null.
    expect(run.summary?.status).toBeTruthy();
  }, 600_000);

  test.skipIf(!dockerAvailable)('B9. a brain-wide schedule on a member Connection is refused', async () => {
    const list = await readJson<{ connections: ConnectionRow[] }>(
      await get('/api/connections'), 'GET /api/connections',
    );
    const overview = await readJson<Overview>(await get('/api/access-overview'), 'GET /api/access-overview');
    const roles = new Map(overview.members.map((m) => [m.membershipId, m.role]));
    const memberConnection = list.connections.find(
      (c) => c.state === 'active' && roles.get(c.membershipId) === 'member',
    );
    expect(memberConnection).toBeTruthy();

    const res = await post('/api/schedules', {
      name: 'weekly-health', preset: 'weekly-health', connectionId: memberConnection!.id,
      operation: 'doctor', kind: 'calendar', calendarHour: 6, calendarMinute: 10,
      calendarDaysOfWeek: [1], params: { remediate: true, yes: true, maxUsd: 5 },
    });
    expect(res.status).toBe(400);
    expect((await readJson<{ scope: string }>(res, 'POST brain-wide schedule')).scope).toBe('brain-wide');
  });

  test.skipIf(!dockerAvailable)('B10. revoking the Connection disables the schedule and raises an alert', async () => {
    // A THROWAWAY Connection: revoking the adopted one would tear down fixtures
    // Gate C and Slice 4 depend on. It is never claimed, so revoking it costs
    // no ops call — but its schedule must be enabled for the hook to see it.
    const memberRes = await post('/api/members', {
      email: `gate-b-throwaway-${RUN_ID}@example.test`, role: 'member',
    });
    expect(memberRes.status).toBe(200);
    const member = await readJson<{ id: string }>(memberRes, 'POST /api/members');

    const connRes = await post('/api/connections', {
      membershipId: member.id,
      writeSpaceId: spacesBySource.internal!.id,
      readSpaceIds: [spacesBySource.internal!.id],
      harness: 'generic',
    });
    expect(connRes.status).toBe(200);
    throwawayConnectionId = (await readJson<{ id: string }>(connRes, 'POST /api/connections')).id;

    const schedRes = await post('/api/schedules', {
      name: 'gate-b-throwaway', preset: 'nightly-dream', connectionId: throwawayConnectionId,
      operation: 'dream', kind: 'calendar', calendarHour: 21, calendarMinute: 5,
      params: { maxUsd: 5, yes: true },
    });
    expect(schedRes.status).toBe(201);
    throwawayScheduleId = (await readJson<{ id: string }>(schedRes, 'POST /api/schedules')).id;

    const revoked = await post(`/api/connections/${throwawayConnectionId}/revoke`, {});
    expect(revoked.status).toBe(200);

    const body = await readJson<{ schedules: ScheduleRow[] }>(await get('/api/schedules'), 'GET /api/schedules');
    const row = body.schedules.find((s) => s.id === throwawayScheduleId);
    expect(row).toBeTruthy();
    expect(row!.enabled).toBe(false);
    expect(row!.disabledReason).toBe('connection_revoked');

    const alerts = await readJson<{ alerts: AlertRow[] }>(await get('/api/schedule-alerts'), 'GET /api/schedule-alerts');
    // Bound to THIS schedule: the org already carries `connection_revoked`
    // alerts from earlier fixtures, so "some alert exists" would prove nothing.
    expect(alerts.alerts.some(
      (a) => a.kind === 'connection_revoked' && a.scheduleId === throwawayScheduleId,
    )).toBe(true);
  }, 300_000);

  test.skipIf(!dockerAvailable)('B11. /api/health surfaces open alert KINDS but never their detail', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    const body = await readJson<{ scheduleAlerts: AlertRow[] }>(res, 'GET /api/health');
    expect(body.scheduleAlerts.length).toBeGreaterThan(0);
    // A `push_blocked` detail can name the file a secret scan matched; a
    // `connection_revoked` detail names a client. Health is unauthenticated.
    for (const a of body.scheduleAlerts) expect(a.detail).toBeUndefined();
  });

  test.skipIf(!dockerAvailable)('B12. /admin is still not reachable', async () => {
    expect((await fetchInsecure('/admin')).status).toBe(404);
  });
});

// ===========================================================================
// Gate C (Task 18) — the Slice 3 exit gate.
//
// The roadmap's exit gate, verbatim: "a 5-minute `sync + embed --stale` schedule
// runs on time across a DST boundary; downtime longer than one interval honors
// the catch-up policy; an overlapping run honors the overlap policy."
//
// The real lane runs for real ONCE — that is Gate B's B8 (a report committed in
// the Space, a git commit as the member). DST, catch-up and overlap are proven
// here against the REAL control DB with an INJECTED clock, by calling
// `materializeDue` / `claimNextRun` directly. That is not a simulation of the
// scheduler: it is the shipped scheduler, the shipped schema and the shipped
// constraints — only `now` is a parameter.
//
// WHICH DATABASE. Not the `bs-fp-pg` scratch DB the slice-0 integration suites
// talk to. B4 created `scheduleId` through the HTTP API against the RUNNING
// stack, so Gate C must read THAT database or every assertion below is
// meaningless. It has no published host port (`caddy is the only publisher` is
// an asserted invariant), so it is reached through a throwaway loopback tunnel
// container this suite creates and removes itself — no committed compose file
// gains a port.
//
// THE CLOCK. `claimNextRun` / `reclaimExpiredLeases` scan `schedule_runs`
// globally with no org scoping, and the live scheduler's own runs sit in this
// DB. Every injected instant below is therefore strictly OUTSIDE the live
// data's window, and the live scheduler is stopped for the duration of the DB
// assertions — its real 15s tick would otherwise materialize from the
// watermarks this gate writes and destroy the deterministic counts.
// ===========================================================================

const GATE_C_NY = 'America/New_York';
/** Spring forward: 02:00-02:59 EST does not exist on 2026-03-08. */
const GATE_C_SPRING = { from: Date.UTC(2026, 2, 8, 6, 50), to: Date.UTC(2026, 2, 8, 7, 30) };
/** Fall back: 01:00-01:59 happens twice on 2026-11-01. */
const GATE_C_FALL = { from: Date.UTC(2026, 10, 1, 4, 55), to: Date.UTC(2026, 10, 1, 7, 5) };
/**
 * The interval grid's PHASE is a fixture input, exactly like the watermark.
 * Occurrences are `anchor + k*interval`, so an anchor that is not aligned to the
 * grid shifts every slot label (01:55 becomes 01:53) and moves the window's
 * edges. The integration suite pins the same thing by passing `anchorMs`.
 */
const GATE_C_ANCHOR_MS = Date.UTC(2026, 0, 1, 0, 0);

const TUNNEL_NAME = 'bs-slice3-pg-tunnel';
const TUNNEL_PORT = 5433;

/** The services the gate must leave up behind it. */
const GATE_C_SERVICES = [
  'caddy', 'control-plane', 'gbrain-ops', 'gbrain-serve', 'gbrain-worker', 'postgres', 'scheduler',
];

type DbRunRow = typeof schema.scheduleRuns.$inferSelect;

let poolA: Sql | null = null;
let poolB: Sql | null = null;
/** The org that owns the gate's schedules: every fixture row carries it. */
let gateOrgId = '';

/** The stack postgres container's control-network name — derived, not guessed. */
async function controlNetworkName(): Promise<string> {
  const id = (await Bun.$`docker compose ${STACK} ps -q postgres`.text()).trim().split('\n')[0] ?? '';
  if (!id) throw new Error('could not resolve the stack postgres container (`compose ps -q postgres`)');
  const fmt = '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}\n{{end}}';
  const names = (await Bun.$`docker inspect ${id} --format ${fmt}`.text())
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const net = names.find((n) => n.endsWith('control-net'));
  if (!net) throw new Error(`the postgres container is not on a control-net network (saw ${names.join(', ')})`);
  return net;
}

/**
 * Bring up the loopback tunnel and RETURN the CONTROL_DATABASE_URL it serves.
 * `docker run -d` returning is not readiness, so the URL is only handed back
 * once a real postgres.js connection through it answers — the same client the
 * assertions below use.
 */
async function openControlTunnel(): Promise<string> {
  const creds = await Bun.$`docker compose ${STACK} exec -T postgres printenv POSTGRES_USER POSTGRES_PASSWORD`
    .quiet().nothrow();
  if (creds.exitCode !== 0) {
    throw new Error(`could not read the stack DB credentials: ${creds.stderr.toString().slice(0, 300)}`);
  }
  const [user, password] = creds.stdout.toString().trim().split(/\r?\n/);
  if (!user || !password) throw new Error('POSTGRES_USER/POSTGRES_PASSWORD are missing from the postgres env');

  const network = await controlNetworkName();
  const publish = `127.0.0.1:${TUNNEL_PORT}:5432`;

  await closeControlTunnel();
  const started = await Bun.$`docker run -d --rm --name ${TUNNEL_NAME} --network ${network} -p ${publish} alpine/socat tcp-listen:5432,fork,reuseaddr tcp-connect:postgres:5432`
    .quiet().nothrow();
  if (started.exitCode !== 0) {
    throw new Error(`the control-DB tunnel failed to start: ${started.stderr.toString().slice(0, 300)}`);
  }

  const url = `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${TUNNEL_PORT}/control`;
  // Real wall-clock polling, deliberately (same rule as `waitForHealth`): the
  // condition belongs to ANOTHER process — a container the daemon must start —
  // and no fake clock can advance it.
  const deadline = Date.now() + 60_000;
  let last = 'no attempt';
  while (Date.now() < deadline) {
    const probe = postgres(url, { max: 1, connect_timeout: 5 });
    try {
      await probe`select 1 as ok`;
      await probe.end();
      return url;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      await probe.end().catch(() => undefined);
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`the control-DB tunnel never accepted a connection in 60s (last: ${last})`);
}

async function closeControlTunnel(): Promise<void> {
  await Bun.$`docker rm -f ${TUNNEL_NAME}`.quiet().nothrow();
}

/** The scheduler's own "I am up" line — printed once, by a fresh process. The
 *  poll is real (the line comes from another container's stdout, which no fake
 *  clock can advance); only its deadline is bounded. */
async function waitForSchedulerTick(sinceIso: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no logs';
  while (Date.now() < deadline) {
    const r = await Bun.$`docker compose ${STACK} logs --no-color --since ${sinceIso} scheduler`
      .quiet().nothrow();
    last = r.stdout.toString();
    const line = last.split('\n').find((l) => /\[scheduler\] \S+ up, tick \d+ms/.test(l));
    if (line) return line;
    await Bun.sleep(2_000);
  }
  throw new Error(`the scheduler never reported itself up (last logs: ${last.slice(-400)})`);
}

// --- fixture writes, straight at the stack's control DB ---------------------

/** Every write is confirmed by its rowcount: a fixture that silently missed
 *  would leave the assertion below measuring nothing. */
async function setWatermark(id: string, ms: number): Promise<void> {
  const updated = await getDb().update(schema.schedules)
    .set({ lastMaterializedAt: new Date(ms) })
    .where(eq(schema.schedules.id, id))
    .returning({ id: schema.schedules.id });
  if (updated.length !== 1) throw new Error(`setWatermark: no schedule ${id} in the stack's control DB`);
}

/** Pin the interval grid's phase — see GATE_C_ANCHOR_MS. */
async function pinAnchor(id: string, ms: number): Promise<void> {
  const updated = await getDb().update(schema.schedules)
    .set({ anchorAt: new Date(ms) })
    .where(eq(schema.schedules.id, id))
    .returning({ id: schema.schedules.id });
  if (updated.length !== 1) throw new Error(`pinAnchor: no schedule ${id} in the stack's control DB`);
}

type PolicyPatch = {
  catchupPolicy?: 'skip' | 'run_latest' | 'run_all';
  overlapPolicy?: 'skip' | 'queue' | 'kill_previous';
};

async function setPolicy(id: string, patch: PolicyPatch): Promise<void> {
  const updated = await getDb().update(schema.schedules)
    .set(patch)
    .where(eq(schema.schedules.id, id))
    .returning({ id: schema.schedules.id });
  if (updated.length !== 1) throw new Error(`setPolicy: no schedule ${id} in the stack's control DB`);
}

/** `materializeDue` reads the ORG's zone for every slot label it stamps, so the
 *  write is confirmed rather than assumed. */
async function setOrgTimezone(tz: string): Promise<void> {
  const [row] = await getDb().update(schema.organizations)
    .set({ timezone: tz })
    .where(eq(schema.organizations.id, gateOrgId))
    .returning({ timezone: schema.organizations.timezone });
  if (!row || row.timezone !== tz) {
    throw new Error(`setOrgTimezone: org ${gateOrgId} reads ${row?.timezone ?? 'missing'}`);
  }
}

async function clearRuns(id: string): Promise<number> {
  const deleted = await getDb().delete(schema.scheduleRuns)
    .where(eq(schema.scheduleRuns.scheduleId, id))
    .returning({ id: schema.scheduleRuns.id });
  return deleted.length;
}

const runsOf = (id: string) =>
  getDb().select().from(schema.scheduleRuns)
    .where(eq(schema.scheduleRuns.scheduleId, id))
    .orderBy(asc(schema.scheduleRuns.fireAt), asc(schema.scheduleRuns.slot));

const runsBetween = (id: string, fromMs: number, toMs: number) =>
  getDb().select().from(schema.scheduleRuns)
    .where(and(
      eq(schema.scheduleRuns.scheduleId, id),
      gte(schema.scheduleRuns.fireAt, new Date(fromMs)),
      lte(schema.scheduleRuns.fireAt, new Date(toMs)),
    ))
    .orderBy(asc(schema.scheduleRuns.fireAt), asc(schema.scheduleRuns.slot));

/** A run another worker already holds, with its lease still in the future. */
async function insertRunning(
  scheduleId: string, slot: string, startedMs: number, leaseExpiresMs: number,
): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.scheduleRuns).values({
    id, scheduleId, organizationId: gateOrgId, slot, fireAt: new Date(startedMs),
    state: 'running', claimedBy: 'gate-c-other-worker',
    startedAt: new Date(startedMs), leaseExpiresAt: new Date(leaseExpiresMs),
  });
  return id;
}

/** A due, unclaimed run — the shape the materializer leaves behind. */
async function insertPending(scheduleId: string, slot: string, fireAtMs: number): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.scheduleRuns).values({
    id, scheduleId, organizationId: gateOrgId, slot, fireAt: new Date(fireAtMs), state: 'pending',
  });
  return id;
}

const runRow = async (runId: string): Promise<DbRunRow> =>
  (await getDb().select().from(schema.scheduleRuns)
    .where(eq(schema.scheduleRuns.id, runId)))[0]!;

const alertKinds = async (scheduleId: string): Promise<string[]> =>
  (await getDb().select({ kind: schema.scheduleAlerts.kind })
    .from(schema.scheduleAlerts)
    .where(eq(schema.scheduleAlerts.scheduleId, scheduleId))).map((r) => r.kind);

/**
 * `claimNextRun` scans `schedule_runs` GLOBALLY — there is no org scope to pin it
 * with — so the three overlap probes below are only meaningful, and only
 * harmless, if the run they insert is the ONLY claimable one. This is a
 * PRECONDITION, not an expectation: without it a stray due run from the live
 * lane would be claimed and restated by the probe, silently rewriting another
 * schedule's history (and leaving a lease behind that the live worker would
 * later reclaim).
 */
async function requireSoleClaimablePending(nowMs: number, mine: string): Promise<void> {
  const rows = await getDb().select({
    id: schema.scheduleRuns.id,
    scheduleId: schema.scheduleRuns.scheduleId,
    fireAt: schema.scheduleRuns.fireAt,
  })
    .from(schema.scheduleRuns)
    .where(and(
      eq(schema.scheduleRuns.state, 'pending'),
      lte(schema.scheduleRuns.fireAt, new Date(nowMs)),
    ));
  const strays = rows.filter((r) => r.id !== mine);
  if (strays.length > 0) {
    throw new Error(
      `the claim probe would pick up ${strays.length} run(s) that are not its own: `
      + strays.map((r) => `${r.scheduleId}@${r.fireAt.toISOString()}`).join(', '),
    );
  }
}

/**
 * A calendar schedule on the REAL stack, through the real API — the DST rules
 * are a property of the scheduler and its inputs, not of a hand-inserted row.
 * The stagger grid assigns the slot (`:30` survives: the only other enabled
 * calendar schedule sits at hour 2 `:05`).
 */
async function createCalendar(name: string, hour: number, minute: number): Promise<string> {
  const res = await post('/api/schedules', {
    name, preset: 'nightly-dream', connectionId: connection.id,
    operation: 'dream', kind: 'calendar', calendarHour: hour, calendarMinute: minute,
    params: { maxUsd: 5, yes: true },
  });
  if (res.status !== 201) {
    throw new Error(`POST /api/schedules (${name}) ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = await readJson<ScheduleRow & { calendarMinute: number | null; slotMinute: number | null }>(
    res, `POST /api/schedules ${name}`,
  );
  // A silently RELOCATED slot would make every `03:30` assertion below vacuous.
  expect(body.kind).toBe('calendar');
  expect(body.calendarMinute).toBe(minute);
  expect(body.slotMinute).toBe(minute);
  return body.id;
}

describe('Slice 3 seam gate C', () => {
  beforeAll(async () => {
    if (!dockerAvailable) return;
    requireGateBReady();

    // Stop the real loop first: its 15s wall-clock tick would materialize from
    // the watermarks this gate writes (2026 watermarks against the real clock
    // are a week-long enumeration) and destroy every deterministic count. It
    // also holds the leader lock C11 needs free.
    const stopped = await compose('stop', 'scheduler');
    if (stopped !== 0) throw new Error(`docker compose stop scheduler exited ${stopped}`);

    const url = await openControlTunnel();
    process.env.CONTROL_DATABASE_URL = url;
    pinDb();

    const [row] = await getDb()
      .select({ orgId: schema.schedules.organizationId })
      .from(schema.schedules)
      .where(eq(schema.schedules.id, scheduleId));
    if (!row) throw new Error(`the live-sync schedule ${scheduleId} is not in the stack's control DB`);
    gateOrgId = row.orgId;

    await pinAnchor(scheduleId, GATE_C_ANCHOR_MS);
    poolA = postgres(url, { max: 4 });
    poolB = postgres(url, { max: 4 });
  }, 300_000);

  afterAll(async () => {
    if (!dockerAvailable) return;
    try {
      await poolA?.end();
      await poolB?.end();
      await closeDb();
    } finally {
      await closeControlTunnel();
      // Leave the stack exactly as the gate found it: the scheduler back up,
      // proven by the line a fresh process prints once it is ticking.
      const since = new Date(Date.now() - 5_000).toISOString();
      const started = await compose('start', 'scheduler');
      if (started !== 0) throw new Error(`docker compose start scheduler exited ${started}`);
      console.log(`[gate C] ${(await waitForSchedulerTick(since, 120_000)).trim()}`);

      const ps = await Bun.$`docker compose ${STACK} ps --format json`.text();
      const states = new Map(ps.split('\n').filter((l) => l.trim()).map(
        (l) => {
          const row = JSON.parse(l) as { Service: string; State: string };
          return [row.Service, row.State] as const;
        },
      ));
      for (const service of GATE_C_SERVICES) expect(states.get(service)).toBe('running');
    }
  }, 300_000);

  test.skipIf(!dockerAvailable)('C1. a 5-minute sync + embed --stale schedule exists on a real Connection', async () => {
    requireGateBReady();
    // Two schedules, one lane: sync at 5 minutes, embed --stale chained behind it.
    // The sub-hourly limit allows exactly one, so embed rides the same schedule
    // via the live-sync preset's two-step operation. Assert the shape:
    const body = await readJson<ScheduleRow>(await get(`/api/schedules/${scheduleId}`), 'GET /api/schedules/:id');
    expect(body.kind).toBe('interval');
    expect(body.intervalSeconds).toBe(300);
    expect(body.enabled).toBe(true);
    expect(body.connectionId).toBe(connection.id);
  });

  test.skipIf(!dockerAvailable)('C2. it fires on time across the SPRING-FORWARD gap', async () => {
    await setWatermark(scheduleId, GATE_C_SPRING.from);
    await setOrgTimezone(GATE_C_NY);
    await materializeDue(GATE_C_SPRING.to);

    const runs = await runsBetween(scheduleId, GATE_C_SPRING.from, GATE_C_SPRING.to);
    expect(runs.length).toBe(8); // 06:55Z .. 07:30Z inclusive

    // "On time" means the real interval never drifts, whatever the wall clock does.
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]!.fireAt.getTime() - runs[i - 1]!.fireAt.getTime()).toBe(300_000);
    }
    const slots = runs.map((r) => r.slot);
    expect(slots).toContain('2026-03-08T01:55');
    expect(slots).toContain('2026-03-08T03:00');
    // 02:00-02:59 local does not exist that day and must never be claimed to.
    expect(slots.some((s) => s.startsWith('2026-03-08T02:'))).toBe(false);
    expect(new Set(slots).size).toBe(slots.length);
  }, 300_000);

  test.skipIf(!dockerAvailable)('C3. it fires on time across the FALL-BACK repeat with no lost hour', async () => {
    await setWatermark(scheduleId, GATE_C_FALL.from);
    await materializeDue(GATE_C_FALL.to);

    const runs = await runsBetween(scheduleId, GATE_C_FALL.from, GATE_C_FALL.to);
    expect(runs.length).toBe(26);
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]!.fireAt.getTime() - runs[i - 1]!.fireAt.getTime()).toBe(300_000);
    }
    const slots = runs.map((r) => r.slot);
    expect(new Set(slots).size).toBe(26); // the unique index held
    // The repeated hour produces twelve #2 slots. Without them the UNIQUE
    // (schedule_id, slot) index would silently swallow an hour of runs.
    expect(slots.filter((s) => s.endsWith('#2')).length).toBe(12);
    expect(slots).toContain('2026-11-01T01:30');
    expect(slots).toContain('2026-11-01T01:30#2');
  }, 300_000);

  test.skipIf(!dockerAvailable)('C4. a nightly calendar job fires ONCE on each transition day', async () => {
    const nightly = await createCalendar('gate-c-nightly', 2, 30); // 02:30 local

    await setWatermark(nightly, Date.UTC(2026, 2, 8, 0, 0));
    await materializeDue(Date.UTC(2026, 2, 8, 23, 0));
    const spring = await runsOf(nightly);
    expect(spring.length).toBe(1);
    expect(spring[0]!.slot).toBe('2026-03-08T03:30'); // gap_policy shift
    expect(spring[0]!.fireAt.getTime()).toBe(Date.UTC(2026, 2, 8, 7, 30));

    const ambiguous = await createCalendar('gate-c-ambiguous', 1, 30);
    await setWatermark(ambiguous, Date.UTC(2026, 10, 1, 0, 0));
    await materializeDue(Date.UTC(2026, 10, 1, 23, 0));
    const fall = await runsOf(ambiguous);
    expect(fall.length).toBe(1); // not twice
    expect(fall[0]!.fireAt.getTime()).toBe(Date.UTC(2026, 10, 1, 5, 30));
  }, 300_000);

  test.skipIf(!dockerAvailable)('C5. downtime longer than one interval honors catch-up = skip (the default)', async () => {
    const base = Date.UTC(2026, 8, 20, 12, 0);
    const after = base + 3_600_000; // an hour down, 12 missed slots
    await setPolicy(scheduleId, { catchupPolicy: 'skip' });
    await setWatermark(scheduleId, base);
    await clearRuns(scheduleId);
    await materializeDue(after);

    const runs = await runsOf(scheduleId);
    expect(runs.filter((r) => r.state === 'pending').length).toBe(1);
    expect(runs.filter((r) => r.state === 'skipped_catchup').length).toBe(11);
    // The misses are RECORDED, not erased: "why didn't my job run last night"
    // is answerable from history.
    expect(runs.length).toBe(12);
  }, 300_000);

  test.skipIf(!dockerAvailable)('C6. catch-up = run_latest runs exactly one missed occurrence', async () => {
    const base = Date.UTC(2026, 8, 21, 12, 0);
    const after = base + 3_600_000;
    await setPolicy(scheduleId, { catchupPolicy: 'run_latest' });
    await setWatermark(scheduleId, base);
    await clearRuns(scheduleId);
    await materializeDue(after);

    const pending = (await runsOf(scheduleId)).filter((r) => r.state === 'pending');
    expect(pending.length).toBe(2);
    expect(pending[0]!.fireAt.getTime()).toBe(after - 300_000); // the most recent miss
  }, 300_000);

  test.skipIf(!dockerAvailable)('C7. catch-up = run_all runs every missed occurrence', async () => {
    const base = Date.UTC(2026, 8, 22, 12, 0);
    await setPolicy(scheduleId, { catchupPolicy: 'run_all' });
    await setWatermark(scheduleId, base);
    await clearRuns(scheduleId);
    await materializeDue(base + 3_600_000);

    const runs = await runsOf(scheduleId);
    expect(runs.filter((r) => r.state === 'pending').length).toBe(12);
    expect(runs.filter((r) => r.state === 'skipped_catchup').length).toBe(0);
  }, 300_000);

  test.skipIf(!dockerAvailable)('C8. an overlapping run honors overlap = skip', async () => {
    const now = Date.UTC(2026, 8, 23, 12, 0);
    await setPolicy(scheduleId, { overlapPolicy: 'skip' });
    await clearRuns(scheduleId);
    const inFlight = await insertRunning(scheduleId, 'c8-inflight', now - 60_000, now + 600_000);
    const waiting = await insertPending(scheduleId, 'c8-next', now - 10_000);

    await requireSoleClaimablePending(now, waiting);
    expect(await claimNextRun('gate-c-worker', now)).toBe('none');
    expect((await runRow(waiting)).state).toBe('skipped_overlap');
    expect((await runRow(inFlight)).state).toBe('running'); // untouched
  }, 300_000);

  test.skipIf(!dockerAvailable)('C9. overlap = queue leaves the waiter pending until the first finishes', async () => {
    const now = Date.UTC(2026, 8, 24, 12, 0);
    await setPolicy(scheduleId, { overlapPolicy: 'queue' });
    await clearRuns(scheduleId);
    const inFlight = await insertRunning(scheduleId, 'c9-inflight', now - 60_000, now + 600_000);
    const waiting = await insertPending(scheduleId, 'c9-next', now - 10_000);

    await requireSoleClaimablePending(now, waiting);
    expect(await claimNextRun('gate-c-worker', now)).toBe('none');
    expect((await runRow(waiting)).state).toBe('pending');

    await finishRun(inFlight, { state: 'succeeded', classification: 'ok', exitCode: 0 });
    const claimed = await claimNextRun('gate-c-worker', now);
    expect(claimed).not.toBe('none');
    expect(claimed === 'none' ? null : claimed.run.id).toBe(waiting);
  }, 300_000);

  test.skipIf(!dockerAvailable)('C10. overlap = kill_previous cancels the in-flight run, then claims', async () => {
    const now = Date.UTC(2026, 8, 25, 12, 0);
    await setPolicy(scheduleId, { overlapPolicy: 'kill_previous' });
    await clearRuns(scheduleId);
    const inFlight = await insertRunning(scheduleId, 'c10-inflight', now - 60_000, now + 600_000);
    const waiting = await insertPending(scheduleId, 'c10-next', now - 10_000);

    await requireSoleClaimablePending(now, waiting);
    const claimed = await claimNextRun('gate-c-worker', now);
    expect(claimed === 'none' ? null : claimed.run.id).toBe(waiting);

    const previous = await runRow(inFlight);
    expect(previous.state).toBe('cancelled');
    expect(previous.classification).toBe('cancelled');
    expect(previous.cancelRequested).toBe(true);
    expect(await alertKinds(scheduleId)).toContain('overlap_killed_previous');
  }, 300_000);

  test.skipIf(!dockerAvailable)('C11. exactly one leader materializes, whatever the replica count', async () => {
    // Two pools, one lock: the double-materialize failure mode that would make
    // every assertion above meaningless.
    await clearRuns(scheduleId);
    await setWatermark(scheduleId, Date.UTC(2026, 8, 26, 12, 0));
    const [a, b] = await Promise.all([
      withLeadership(poolA!, async () => { await materializeDue(Date.UTC(2026, 8, 26, 12, 15)); }),
      withLeadership(poolB!, async () => { await materializeDue(Date.UTC(2026, 8, 26, 12, 15)); }),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect((await runsOf(scheduleId)).length).toBe(3);
  }, 300_000);

  test.skipIf(!dockerAvailable)('C12. the schedule is left enabled and healthy for the next session', async () => {
    await setPolicy(scheduleId, { catchupPolicy: 'skip', overlapPolicy: 'skip' });
    await clearRuns(scheduleId);
    await setWatermark(scheduleId, Date.now());
    const body = await readJson<ScheduleRow>(await get(`/api/schedules/${scheduleId}`), 'GET /api/schedules/:id');
    expect(body.enabled).toBe(true);
    expect(body.disabledReason).toBeNull();
  }, 300_000);
});
