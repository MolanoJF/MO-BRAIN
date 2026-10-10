import { mock, test, expect, describe, beforeAll, afterAll, beforeEach, setSystemTime } from 'bun:test';
import { randomUUID } from 'node:crypto';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
process.env.PUBLIC_URL ??= 'http://127.0.0.1:3131';
// D12: the runner lane is CONFIGURED as soon as the token is non-empty. Without
// this the whole file would run in the `disabled` state and every agent_prompt
// create would be a 409 — which is what the disabled probe below asserts on
// purpose, by unsetting it.
process.env.RUNNER_TOKEN ??= 'it-not-a-real-runner-token';

type CallOpts = { json?: boolean; dryRun?: boolean; timeoutMs?: number };
type OpsResult = {
  ok: boolean; exitCode: number; argv: string[];
  stdout: string; stderr: string; json: unknown;
};

function defaultOk(op: string, opts?: CallOpts): OpsResult {
  return {
    ok: true,
    exitCode: 0,
    argv: ['gbrain', ...op.split('.')],
    stdout: '{}',
    stderr: '',
    json: op === 'mcp.grant'
      ? { status: 'preview', grant: { profile: 'memory-writer', sourceId: 'customers' } }
      : { ok: true, ...(opts?.dryRun ? {} : {}) },
  };
}

let callOpsHandler: (op: string, params?: Record<string, unknown>, opts?: CallOpts) => Promise<OpsResult> | OpsResult =
  (op, _params, opts) => defaultOk(op, opts);

mock.module('../../src/control/opsClient.ts', () => ({
  // `src/control/spend.ts` imports this alongside the others; a mock that
  // omits a real export makes the whole graph unloadable (Slice 4 hazard (a)).
  brainUsage: async () => { throw new Error('ops unreachable'); },
  mcpWhoami: async () => ({ ok: false, status: 401, error: 'invalid_token' }),
  callOps: async (op: string, params?: Record<string, unknown>, opts?: CallOpts) =>
    callOpsHandler(op, params, opts),
  patchFilePlaneConfig: async () => {},
  putSchemaPack: async () => {},
  putSchemaPackJson: async () => {},
  gitScaffold: async () => ({ created: [], skipped: [], sha: null }),
  removeSchemaPack: async () => ({ removed: false }),
  seedSpace: async () => {},
  resetBrainSchema: async () => {},
  pauseBrainWriters: async () => {},
  resumeBrainWriters: async () => {},
  takeGrantCredentials: async () => ({}),
  // Task 5's revoke path (connections.ts) imports this alongside the others; a
  // mock that omits a real export makes the whole graph unloadable.
  deleteCredentialJournal: async () => ({ deleted: true }),
  opsHealthy: async () => true,
  commitAsMember: async () => ({ committed: false, sha: null }),
  inspectRepos: async () => [],
  // Same rule, and the graph is loaded before this suite's own tests run:
  // `src/agent/revert.ts` re-exports `classifyExit` from `scheduler/execute.ts`,
  // which imports `writeReport` here. Without it the whole file dies at load
  // with `Export named 'writeReport' not found` and none of the assertions
  // below ever run. The health path never calls it; it exists so the mock
  // mirrors the module it replaces.
  writeReport: async () => ({ relPath: '', committed: false, sha: null }),
  cancelRun: async () => ({ cancelled: false }),
  gitRange: async (sourceId: string) => ({
    sourceId, before: '', after: '', commits: [], files: [],
  }),
  gitRevertRange: async () => ({ reverted: false, reason: 'nothing_to_revert' }),
  // Task 10's revert probes the tree before it removes a page, and `revert.ts` is
  // loaded by the app graph (`routes/runs.ts`), so this export must exist even
  // though no probe here exercises a revert: answering "neither on disk nor in
  // git" is the state a route test that never reverts wants anyway.
  gitPathExists: async (sourceId: string, paths: readonly string[]) => ({
    sourceId,
    root: `/repos/${sourceId}`,
    paths: paths.map((path) => ({ path, onDisk: false, inGit: false })),
  }),
  auditTail: async () => [],
  // S1: routes/files.ts imports these alongside the rest, so a mock that omits
  // them makes the whole app graph unloadable.
  gitTree: async (sourceId: string) => ({ sourceId, root: `/repos/${sourceId}`, entries: [] }),
  gitExportBundle: async () => new Response(null),
  gitReadFile: async (sourceId: string, path: string) => ({ content: '', sha: '', size: 0 }),
  gitWriteFile: async (req: { sourceId: string; path: string; content: string; expectedSha: string }) =>
    ({ committed: true, sha: 'written-sha' }),
}));

// mock.module must be registered before the app's import graph loads, so these
// are dynamic on purpose: a static import is hoisted above the mock and the
// real opsClient (and its network sidecar) would be captured instead.
const { default: app } = await import('../../src/control/app.ts');
const { runMigrations, getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { revokeConnection } = await import('../../src/control/connections.ts');
const { materializeDue } = await import('../../src/scheduler/materialize.ts');
// Same ordering rule as the block above: these read env at module scope too.
const { runnerStatus, recordRunnerSeen, RUNNER_SEEN_WINDOW_MS } =
  await import('../../src/agent/runners.ts');
const { HARNESS_PIN } = await import('../../src/runner/pin.ts');
const { MODEL_PRICING } = await import('../../src/gateway/pricing.ts');
const { eq, and, inArray } = await import('drizzle-orm');

pinDb();

const PASS = 'a-long-enough-password';
const NOPE = '00000000-0000-0000-0000-000000000000';
const ORG = `org-${randomUUID()}`;
/**
 * The control DB is shared and persists between runs, and `users.email` is
 * unique — fixed addresses would make a second run fail at sign-up (422).
 */
const RUN = randomUUID().slice(0, 8);
const createdUsers: string[] = [];

let adminCookie = '';
let memberCookie = '';
let viewerCookie = '';
let ownerCookie = '';

let memberMembership = '';
let ownerMembership = '';
let otherMembership = '';
let writeSpace = '';
let readSpace = '';

/** The member's own Connection; every default body targets it. */
let memberConn = '';
let ownerConn = '';
let otherConn = '';

async function signIn(email: string): Promise<string> {
  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie') ?? '';
}

async function hit(method: string, path: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  const hasBody = method !== 'GET' && method !== 'DELETE';
  if (hasBody || body !== undefined) headers['content-type'] = 'application/json';
  return app.request(path, {
    method, headers, body: hasBody ? JSON.stringify(body ?? {}) : undefined,
  });
}

/** Names are org-unique, so every probe gets its own. */
const uniqueName = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

async function addUser(email: string, role: 'owner' | 'admin' | 'member' | 'viewer'): Promise<string> {
  const signed = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASS, name: email }),
  });
  expect(signed.status).toBe(200);
  const [user] = await getDb().select().from(schema.users).where(eq(schema.users.email, email));
  createdUsers.push(user!.id);
  const membershipId = randomUUID();
  await getDb().insert(schema.memberships).values({
    id: membershipId, userId: user!.id, organizationId: ORG, role,
  });
  return membershipId;
}

async function addConnection(membershipId: string, clientName: string, over: Partial<{
  state: 'pending' | 'active' | 'revoked';
  gbrainClientId: string | null;
}> = {}): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.connections).values({
    id,
    organizationId: ORG,
    membershipId,
    writeSpaceId: writeSpace,
    readSpaceIds: [readSpace],
    harness: 'generic',
    clientName,
    gbrainClientId: over.gbrainClientId === undefined ? 'gbrain_cl_routes' : over.gbrainClientId,
    profile: 'memory-writer',
    tokenTtl: 3600,
    state: over.state ?? 'active',
    provisionedAt: over.state === 'pending' ? null : new Date(),
  });
  return id;
}

beforeAll(async () => {
  await runMigrations();
  await getDb().insert(schema.organizations).values({
    id: ORG, name: 'Schedule Routes', slug: `sched-routes-${randomUUID().slice(0, 8)}`,
  });

  ownerMembership = await addUser(`sr-owner-${RUN}@example.test`, 'owner');
  await addUser(`sr-admin-${RUN}@example.test`, 'admin');
  memberMembership = await addUser(`sr-member-${RUN}@example.test`, 'member');
  await addUser(`sr-viewer-${RUN}@example.test`, 'viewer');
  otherMembership = await addUser(`sr-other-${RUN}@example.test`, 'member');

  writeSpace = randomUUID();
  readSpace = randomUUID();
  await getDb().insert(schema.spaces).values([
    { id: writeSpace, organizationId: ORG, sourceId: 'customers', name: 'Customers', kind: 'local-git' },
    { id: readSpace, organizationId: ORG, sourceId: 'shared', name: 'Shared', kind: 'local-git' },
  ]);

  ownerConn = await addConnection(ownerMembership, `bs-owner-${RUN}`);
  memberConn = await addConnection(memberMembership, `bs-member-${RUN}`);
  otherConn = await addConnection(otherMembership, `bs-other-${RUN}`);

  ownerCookie = await signIn(`sr-owner-${RUN}@example.test`);
  adminCookie = await signIn(`sr-admin-${RUN}@example.test`);
  memberCookie = await signIn(`sr-member-${RUN}@example.test`);
  viewerCookie = await signIn(`sr-viewer-${RUN}@example.test`);
}, 90_000);

beforeEach(async () => {
  callOpsHandler = (op, _params, opts) => defaultOk(op, opts);
  // Cascades their runs. Alerts and audit rows survive that cascade by design
  // (alerts outlive their schedule; audit_log has no org FK), so they are
  // cleared explicitly rather than accumulating across probes.
  await getDb().delete(schema.schedules).where(eq(schema.schedules.organizationId, ORG));
  await getDb().delete(schema.scheduleAlerts).where(eq(schema.scheduleAlerts.organizationId, ORG));
  await getDb().delete(schema.auditLog).where(eq(schema.auditLog.organizationId, ORG));
  // D2's sighting record is deployment-wide, not org-scoped: it is written by
  // `POST /api/runs/claim`, which names a runner and no organization. Every
  // other file in this directory claims runs through that route, so "no runner
  // has ever been seen" has to be CONSTRUCTED here rather than assumed.
  await getDb().delete(schema.runnerPresence);
});

afterAll(async () => {
  await getDb().delete(schema.auditLog).where(eq(schema.auditLog.organizationId, ORG));
  await getDb().delete(schema.organizations).where(eq(schema.organizations.id, ORG));
  // Sessions, accounts and memberships cascade from the user.
  await getDb().delete(schema.users).where(inArray(schema.users.id, createdUsers));
  await closeDb();
});

// --- bodies -----------------------------------------------------------------

function intervalBody(over: Record<string, unknown> = {}) {
  return {
    name: uniqueName('live-sync'),
    connectionId: memberConn,
    kind: 'interval',
    operation: 'sync',
    intervalSeconds: 900,
    params: {},
    ...over,
  };
}

function calendarBody(hour: number, minute: number, over: Record<string, unknown> = {}) {
  return {
    name: uniqueName('nightly-dream'),
    connectionId: memberConn,
    kind: 'calendar',
    operation: 'dream',
    calendarHour: hour,
    calendarMinute: minute,
    calendarDaysOfWeek: null,
    params: { maxUsd: 5, yes: true },
    ...over,
  };
}

async function createSchedule(body: unknown, cookie = adminCookie): Promise<string> {
  const res = await hit('POST', '/api/schedules', cookie, body);
  expect(res.status).toBe(201);
  const row = await res.json() as { id: string };
  return row.id;
}

const scheduleRow = async (id: string) =>
  (await getDb().select().from(schema.schedules).where(eq(schema.schedules.id, id)))[0]!;

const alertsFor = (scheduleId: string) =>
  getDb().select().from(schema.scheduleAlerts)
    .where(and(
      eq(schema.scheduleAlerts.organizationId, ORG),
      eq(schema.scheduleAlerts.scheduleId, scheduleId),
    ));

async function insertSchedule(over: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.schedules).values({
    id,
    organizationId: ORG,
    connectionId: memberConn,
    name: uniqueName('probe'),
    operation: 'sync',
    kind: 'interval',
    intervalSeconds: 3600,
    anchorAt: new Date(),
    createdBy: 'test',
    ...over,
  });
  return id;
}

// --- the agent lane (D12, honesty rule 8) -----------------------------------

/**
 * A CONNECTED runner, as the ledger records one: an `agent_prompt` schedule (the
 * payload-shape CHECK requires its five agent columns) and a run that runner has
 * claimed with an unexpired lease. That claim is the only evidence the control
 * plane honestly has, so it is what the create gate looks for.
 */
async function seedAgentLane(over: { leaseMs?: number } = {}): Promise<string> {
  const scheduleId = randomUUID();
  await getDb().insert(schema.schedules).values({
    id: scheduleId,
    organizationId: ORG,
    connectionId: memberConn,
    name: uniqueName('agent-lane'),
    jobType: 'agent_prompt',
    operation: null,
    agentPrompt: 'lane probe',
    agentModel: 'claude-haiku-4-5',
    agentMaxTokens: 1024,
    agentBudgetUsd: '1',
    agentHarnessVersion: HARNESS_PIN,
    kind: 'interval',
    intervalSeconds: 3600,
    anchorAt: new Date(),
    createdBy: 'test',
  });

  const runId = randomUUID();
  await getDb().insert(schema.scheduleRuns).values({
    id: runId,
    scheduleId,
    organizationId: ORG,
    slot: `lane:${randomUUID().slice(0, 8)}`,
    fireAt: new Date(),
    state: 'running',
    claimedBy: 'runner-test-0123abcd',
    startedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + (over.leaseMs ?? 300_000)),
  });
  return runId;
}

/** A runner's claim on a gbrain_command row: the OTHER lane's consumer. */
async function seedCommandLane(): Promise<void> {
  const scheduleId = await insertSchedule();
  await getDb().insert(schema.scheduleRuns).values({
    id: randomUUID(),
    scheduleId,
    organizationId: ORG,
    slot: `sched:${randomUUID().slice(0, 8)}`,
    fireAt: new Date(),
    state: 'running',
    claimedBy: 'scheduler-test-worker',
    startedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 300_000),
  });
}

function agentBody(over: Record<string, unknown> = {}) {
  return {
    name: uniqueName('nightly-briefing'),
    connectionId: memberConn,
    jobType: 'agent_prompt',
    agentPrompt: 'Read the pages that changed in this Space tonight and write one briefing page.',
    agentModel: 'claude-haiku-4-5',
    agentMaxTokens: 4096,
    agentBudgetUsd: '2',
    kind: 'calendar',
    calendarHour: 3,
    calendarMinute: 5,
    calendarDaysOfWeek: null,
    ...over,
  };
}

/** `RUNNER_TOKEN` is read per call, so a probe can move the lane in and out of `disabled`. */
async function withRunnerToken<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env.RUNNER_TOKEN;
  if (value === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = before;
  }
}

describe('RBAC', () => {
  const ROUTE_TABLE: Array<{ method: string; path: string; body?: unknown }> = [
    { method: 'GET', path: '/api/schedules' },
    { method: 'GET', path: `/api/schedules/${NOPE}` },
    { method: 'POST', path: '/api/schedules', body: {} },
    { method: 'PATCH', path: `/api/schedules/${NOPE}`, body: { enabled: false } },
    { method: 'DELETE', path: `/api/schedules/${NOPE}` },
    { method: 'GET', path: `/api/schedules/${NOPE}/runs` },
    { method: 'POST', path: `/api/schedules/${NOPE}/run-now`, body: {} },
    { method: 'GET', path: '/api/schedule-presets' },
    { method: 'GET', path: '/api/schedule-alerts' },
    { method: 'POST', path: `/api/schedule-alerts/${NOPE}/ack`, body: {} },
    { method: 'GET', path: '/api/org/schedule-settings' },
    { method: 'PATCH', path: '/api/org/schedule-settings', body: { timezone: 'UTC' } },
  ];

  test('an unauthenticated caller gets 401 on every schedule route', async () => {
    for (const row of ROUTE_TABLE) {
      expect((await hit(row.method, row.path, undefined, row.body)).status).toBe(401);
    }
  });

  test('a viewer may read schedules but never create one', async () => {
    const list = await hit('GET', '/api/schedules', viewerCookie);
    expect(list.status).toBe(200);
    expect(Array.isArray((await list.json() as { schedules: unknown[] }).schedules)).toBe(true);

    expect((await hit('POST', '/api/schedules', viewerCookie, intervalBody())).status).toBe(403);
    for (const row of [
      { method: 'PATCH', path: `/api/schedules/${NOPE}`, body: { enabled: false } },
      { method: 'DELETE', path: `/api/schedules/${NOPE}` },
      { method: 'POST', path: `/api/schedules/${NOPE}/run-now`, body: {} },
      { method: 'POST', path: `/api/schedule-alerts/${NOPE}/ack`, body: {} },
      { method: 'PATCH', path: '/api/org/schedule-settings', body: { timezone: 'UTC' } },
    ]) {
      expect((await hit(row.method, row.path, viewerCookie, row.body)).status).toBe(403);
    }
    expect((await hit('GET', '/api/schedule-presets', viewerCookie)).status).toBe(200);
    expect((await hit('GET', '/api/schedule-alerts', viewerCookie)).status).toBe(200);
  });

  test('a member may create a source-scoped schedule on their OWN Connection', async () => {
    const name = uniqueName('live-sync');
    const res = await hit('POST', '/api/schedules', memberCookie,
      intervalBody({ name, connectionId: memberConn, intervalSeconds: 900 }));
    expect(res.status).toBe(201);

    const body = await res.json() as {
      id: string; connectionId: string; kind: string; enabled: boolean; slotMinute: number | null;
      createdBy: string;
    };
    expect(body.connectionId).toBe(memberConn);
    expect(body.kind).toBe('interval');
    expect(body.enabled).toBe(true);
    // An interval schedule carries no stagger slot: only calendar jobs do.
    expect(body.slotMinute).toBeNull();

    const stored = await scheduleRow(body.id);
    expect(stored.name).toBe(name);
    expect(stored.intervalSeconds).toBe(900);
    expect(stored.anchorAt).not.toBeNull();
  });

  test("a member may NOT create a schedule on someone else's Connection", async () => {
    const res = await hit('POST', '/api/schedules', memberCookie, intervalBody({ connectionId: otherConn }));
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('forbidden');
    expect((await getDb().select().from(schema.schedules)
      .where(eq(schema.schedules.organizationId, ORG))).length).toBe(0);
  });

  test('an admin may create a schedule on another member\'s Connection', async () => {
    // The Connection decides the fence and the commit identity, so an
    // admin-or-better caller acts org-wide rather than only on their own.
    expect((await hit('POST', '/api/schedules', adminCookie,
      intervalBody({ connectionId: otherConn }))).status).toBe(201);
  });

  test('a brain-wide schedule requires an admin-or-better Connection', async () => {
    const refused = await hit('POST', '/api/schedules', adminCookie, {
      name: uniqueName('weekly-health'), preset: 'weekly-health', connectionId: memberConn,
    });
    expect(refused.status).toBe(400);
    const refusal = await refused.json() as { error: string; scope?: string };
    expect(refusal.error).toMatch(/brain-wide/);
    expect(refusal.scope).toBe('brain-wide');
    expect((await getDb().select().from(schema.schedules)
      .where(eq(schema.schedules.organizationId, ORG))).length).toBe(0);

    // ...and the same preset on an owner's Connection is allowed: the rule is
    // about the Connection's member, not about who is asking.
    const allowed = await hit('POST', '/api/schedules', adminCookie, {
      name: uniqueName('weekly-health'), preset: 'weekly-health', connectionId: ownerConn,
    });
    expect(allowed.status).toBe(201);
    const body = await allowed.json() as { operation: string; calendarHour: number; slotMinute: number };
    expect(body.operation).toBe('doctor');
    expect(body.calendarHour).toBe(6);
    expect(body.slotMinute).toBe(10);
  });

  test('the autopilot tripwire is admin-gated like any brain-wide preset', async () => {
    const refused = await hit('POST', '/api/schedules', adminCookie, {
      name: uniqueName('autopilot-tripwire'), preset: 'autopilot-tripwire', connectionId: memberConn,
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ scope: 'brain-wide' });

    const allowed = await hit('POST', '/api/schedules', adminCookie, {
      name: uniqueName('autopilot-tripwire'), preset: 'autopilot-tripwire', connectionId: ownerConn,
    });
    expect(allowed.status).toBe(201);
    const body = await allowed.json() as {
      operation: string; calendarHour: number; slotMinute: number; reportPolicy: string; timeoutSeconds: number;
    };
    expect(body).toMatchObject({
      operation: 'autopilot-status', calendarHour: 7, slotMinute: 5,
      reportPolicy: 'on_change_or_failure', timeoutSeconds: 900,
    });
  });

  test('a member asking for a brain-wide command on their own Connection is still refused', async () => {
    const res = await hit('POST', '/api/schedules', memberCookie, {
      name: uniqueName('weekly-health'), operation: 'doctor', connectionId: memberConn,
      kind: 'calendar', calendarHour: 7, calendarMinute: 5, calendarDaysOfWeek: [1],
      params: { remediate: true, yes: true, maxUsd: 5 },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ scope: 'brain-wide' });
  });

  test('a schedule row carries the Connection denormalization the console renders', async () => {
    const id = await createSchedule(intervalBody({ connectionId: memberConn }));
    const body = await (await hit('GET', `/api/schedules/${id}`, viewerCookie)).json() as {
      id: string;
      connection: {
        id: string; clientName: string; state: string; memberRole: string; writeSpace: string;
      } | null;
    };
    expect(body.connection).toEqual({
      id: memberConn,
      clientName: `bs-member-${RUN}`,
      state: 'active',
      memberRole: 'member',
      writeSpace: 'customers',
    });
  });
});

describe('validation', () => {
  test('a fenced param in the request body is REFUSED, not merged', async () => {
    const body = intervalBody({ params: { source: 'someone-elses-space' } });
    const res = await hit('POST', '/api/schedules', adminCookie, body);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/fenced/);

    // Refused, not merged: no row, and nothing carrying the fence anywhere.
    const rows = await getDb().select().from(schema.schedules)
      .where(eq(schema.schedules.organizationId, ORG));
    expect(rows.length).toBe(0);
  });

  test('a colliding calendar slot is refused WITH the next free slot', async () => {
    await createSchedule(calendarBody(2, 5));
    const res = await hit('POST', '/api/schedules', adminCookie, calendarBody(2, 5));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'slot_taken', nextFree: 10 });
    // Refused, never relocated: only the first schedule exists.
    const rows = await getDb().select().from(schema.schedules)
      .where(eq(schema.schedules.organizationId, ORG));
    expect(rows.length).toBe(1);
    expect(rows[0]!.slotMinute).toBe(5);
  });

  test('a calendar slot off the grid snaps up, and the snap is what gets stored', async () => {
    const id = await createSchedule(calendarBody(2, 7));
    const stored = await scheduleRow(id);
    expect(stored.calendarMinute).toBe(10);
    expect(stored.slotMinute).toBe(10);
  });

  test('a second sub-hourly schedule is refused — one live-sync lane per org', async () => {
    const first = await createSchedule(intervalBody({ intervalSeconds: 300 }));
    const res = await hit('POST', '/api/schedules', adminCookie, intervalBody({ intervalSeconds: 600 }));
    expect(res.status).toBe(409);
    const refusal = await res.json() as { error: string; holder?: string; detail?: string };
    expect(refusal.error).toBe('sub_hourly_limit');
    // The refusal names the schedule holding the lane, so the console does not
    // have to guess which one to turn off.
    expect(refusal.holder).toBe((await scheduleRow(first)).name);
    expect(refusal.detail).toMatch(/sub-hourly/);

    // An hourly schedule is not sub-hourly and is always allowed.
    expect((await hit('POST', '/api/schedules', adminCookie,
      intervalBody({ intervalSeconds: 3600 }))).status).toBe(201);
  });

  test('a non-IANA timezone is rejected on the org settings route', async () => {
    const bad = await hit('PATCH', '/api/org/schedule-settings', adminCookie, { timezone: 'EST' });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toBe('invalid_timezone');

    const good = await hit('PATCH', '/api/org/schedule-settings', adminCookie,
      { timezone: 'America/New_York' });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ settings: { timezone: 'America/New_York' } });
    const [org] = await getDb().select().from(schema.organizations)
      .where(eq(schema.organizations.id, ORG));
    expect(org!.timezone).toBe('America/New_York');
  });

  test('the org settings are readable by a viewer, and a PATCH is observable through the GET', async () => {
    const before = await hit('GET', '/api/org/schedule-settings', viewerCookie);
    expect(before.status).toBe(200);
    const [org] = await getDb().select().from(schema.organizations)
      .where(eq(schema.organizations.id, ORG));
    expect(await before.json()).toEqual({
      settings: {
        timezone: org!.timezone,
        quietHoursStart: org!.quietHoursStart,
        quietHoursEnd: org!.quietHoursEnd,
      },
    });

    // The window the console renders in org-local time: write it, read it back.
    const patched = await hit('PATCH', '/api/org/schedule-settings', adminCookie,
      { timezone: 'America/Chicago', quietHoursStart: 21, quietHoursEnd: 7 });
    expect(patched.status).toBe(200);
    const settings = { timezone: 'America/Chicago', quietHoursStart: 21, quietHoursEnd: 7 };
    expect(await patched.json()).toEqual({ settings });

    const after = await hit('GET', '/api/org/schedule-settings', viewerCookie);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ settings });
    // ...and it is the row, not an echo of the request body.
    const [stored] = await getDb().select().from(schema.organizations)
      .where(eq(schema.organizations.id, ORG));
    expect(stored!.timezone).toBe('America/Chicago');
    expect(stored!.quietHoursStart).toBe(21);
    expect(stored!.quietHoursEnd).toBe(7);
  });

  test('quiet hours must be whole hours in range', async () => {
    for (const hour of [25, -1, 24, 8.5]) {
      const res = await hit('PATCH', '/api/org/schedule-settings', adminCookie, { quietHoursStart: hour });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe('invalid_quiet_hours');
    }
    expect((await hit('PATCH', '/api/org/schedule-settings', adminCookie, { quietHoursEnd: 24 })).status).toBe(400);

    const ok = await hit('PATCH', '/api/org/schedule-settings', adminCookie,
      { quietHoursStart: 22, quietHoursEnd: 6 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ settings: { quietHoursStart: 22, quietHoursEnd: 6 } });
  });

  test('a schedule name must be slug-shaped — it becomes a reports/ directory', async () => {
    for (const bad of ['../escape', 'Live Sync', 'a/b', '-leading', '', 'a'.repeat(64)]) {
      const res = await hit('POST', '/api/schedules', adminCookie, intervalBody({ name: bad }));
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe('invalid_name');
    }
    // Refused, never sanitized: no `escape`, `live-sync` or `a-b` row was made.
    const rows = await getDb().select().from(schema.schedules)
      .where(eq(schema.schedules.organizationId, ORG));
    expect(rows.length).toBe(0);
  });

  test('an unknown operation or preset is named, not stored', async () => {
    const op = await hit('POST', '/api/schedules', adminCookie,
      intervalBody({ operation: 'rm -rf /' }));
    expect(op.status).toBe(400);
    expect((await op.json() as { error: string }).error).toBe('unknown_operation');

    const preset = await hit('POST', '/api/schedules', adminCookie, {
      name: uniqueName('nope'), preset: 'not-a-preset', connectionId: memberConn,
    });
    expect(preset.status).toBe(400);
    expect((await preset.json() as { error: string }).error).toBe('unknown_preset');
  });

  test('a duplicate schedule name is refused, because it names a directory', async () => {
    const name = uniqueName('live-sync');
    // Hourly, so the sub-hourly lane check cannot answer first: this probe is
    // about the name, and the name is the file path.
    await createSchedule(intervalBody({ name, intervalSeconds: 3600 }));
    const res = await hit('POST', '/api/schedules', adminCookie,
      intervalBody({ name, intervalSeconds: 3600 }));
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe('name_taken');
  });

  test('an unknown body value never reaches a row as a raw Postgres error', async () => {
    const res = await hit('POST', '/api/schedules', adminCookie,
      intervalBody({ catchupPolicy: 'run_everything' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_catchupPolicy' });

    const timeout = await hit('POST', '/api/schedules', adminCookie, intervalBody({ timeoutSeconds: 5 }));
    expect(timeout.status).toBe(400);
    expect(await timeout.json()).toMatchObject({ error: 'invalid_timeoutSeconds' });
  });
});

describe('the runner lane: three states, and only one of them is green', () => {
  test('an unconfigured lane is `disabled` — and an empty bearer is not configured either', async () => {
    expect(await withRunnerToken(undefined, runnerStatus))
      .toEqual({ state: 'disabled', lastSeenAt: null, version: null });
    // Compose interpolates `${RUNNER_TOKEN:-}` to the empty string on every
    // runner-less deployment, and an empty bearer must never authenticate — so
    // empty IS the lane being off, not "configured, nothing claimed yet".
    expect(await withRunnerToken('', runnerStatus))
      .toEqual({ state: 'disabled', lastSeenAt: null, version: null });
    expect(await withRunnerToken('   ', runnerStatus))
      .toEqual({ state: 'disabled', lastSeenAt: null, version: null });
  });

  test('a configured lane nothing has ever claimed is `never_claimed`, with no lastSeenAt', async () => {
    expect(await runnerStatus()).toEqual({ state: 'never_claimed', lastSeenAt: null, version: null });
  });

  test('a claim with a live lease is `connected`; the scheduler claiming its own lane is not evidence', async () => {
    // The scheduler claims `gbrain_command` rows with the same two columns. A
    // health probe that counted them would report a runner that does not exist.
    await seedCommandLane();
    expect((await runnerStatus()).state).toBe('never_claimed');

    const runId = await seedAgentLane();
    const status = await runnerStatus();
    expect(status.state).toBe('connected');
    // The claim moment is the honest `lastSeenAt`: heartbeat renews
    // `lease_expires_at` but records no timestamp of its own.
    const [row] = await getDb().select().from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.id, runId));
    expect(status.lastSeenAt!.toISOString()).toBe(row!.startedAt!.toISOString());
    // The ledger records WHO claimed (`claimed_by`), never which harness build.
    // An absent version is honest; a fabricated one would not be.
    expect(status.version).toBeNull();
  });

  test('a lapsed lease is not `connected`, and lastSeenAt still says a runner was here', async () => {
    await seedAgentLane({ leaseMs: -60_000 });
    const status = await runnerStatus();
    expect(status.state).toBe('never_claimed');
    expect(status.lastSeenAt).toBeInstanceOf(Date);
    expect(status.version).toBeNull();
  });

  // D2. The sighting is the claim REQUEST, which arrives before any run exists:
  // that is what makes an idle-but-present runner visible, and it is what the
  // old live-lease definition of `connected` got wrong.
  test('a runner that has been seen is `connected`, with the version it announced', async () => {
    const announcedAt = Date.now();
    await recordRunnerSeen('runner-seen-0123abcd', HARNESS_PIN, announcedAt);

    const status = await runnerStatus();
    expect(status.state).toBe('connected');
    expect(status.version).toBe(HARNESS_PIN);
    // The sighting's own moment, and no claim anywhere: `lastSeenAt` is the row's
    // timestamp, not a run it never had.
    expect(status.lastSeenAt!.getTime()).toBe(announcedAt);
    expect((await getDb().select().from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.organizationId, ORG))).length).toBe(0);
  });

  test('a sighting older than the window is not `connected` — and lastSeenAt still says it was here', async () => {
    await recordRunnerSeen(
      'runner-gone-0123abcd', HARNESS_PIN, Date.now() - RUNNER_SEEN_WINDOW_MS - 1_000,
    );
    const status = await runnerStatus();
    expect(status.state).toBe('never_claimed');
    expect(Date.now() - status.lastSeenAt!.getTime()).toBeGreaterThan(RUNNER_SEEN_WINDOW_MS);
    expect(status.version).toBe(HARNESS_PIN);
  });

  test('a request with no runner id, or no version, is not a sighting at all', async () => {
    // Both are refused as request shape by the claim route (`runner_never_seen`,
    // `harness_version_required`), so neither may leave a row: a sighting with no
    // identity would put an empty string in /api/health's `version`.
    await recordRunnerSeen('', HARNESS_PIN);
    await recordRunnerSeen('runner-partial-0123abcd', '   ');
    expect(await runnerStatus()).toEqual({ state: 'never_claimed', lastSeenAt: null, version: null });
    expect((await getDb().select().from(schema.runnerPresence)).length).toBe(0);
  });
});

describe('agent_prompt schedules', () => {
  test('the preset supplies the payload, and the row is the whole shape', async () => {
    await seedAgentLane();
    const res = await hit('POST', '/api/schedules', adminCookie, {
      name: uniqueName('nightly-agent'),
      connectionId: memberConn,
      preset: 'nightly-agent-briefing',
      kind: 'calendar',
      calendarHour: 3,
      calendarMinute: 5,
    });
    expect(res.status).toBe(201);
    const created = await res.json() as {
      id: string; agentPrompt: string; agentModel: string; agentBudgetUsd: string;
    } & Record<string, unknown>;
    expect(created).toMatchObject({
      jobType: 'agent_prompt',
      // shape_matches_job_type: an agent row has no gbrain operation at all.
      operation: null,
      preset: 'nightly-agent-briefing',
      agentModel: 'claude-haiku-4-5',
      agentMaxTokens: 16384,
      agentBudgetUsd: '2',
      agentHarnessVersion: HARNESS_PIN,
    });
    expect(created.agentPrompt).toMatch(/briefing/);
    expect(Object.keys(MODEL_PRICING.models)).toContain(created.agentModel);

    const stored = await scheduleRow(created.id);
    expect(stored.jobType).toBe('agent_prompt');
    expect(stored.operation).toBeNull();
    expect(stored.agentPrompt).toBe(created.agentPrompt);
    expect(stored.agentBudgetUsd).toBe('2');
    // Timing is orthogonal to the payload shape, and stays so.
    expect(stored.kind).toBe('calendar');
    expect(stored.slotMinute).toBe(5);
  });

  test('an explicit payload is stored as given, against OUR declared pin', async () => {
    await seedAgentLane();
    const id = await createSchedule(agentBody({
      agentModel: 'claude-sonnet-4-6', agentMaxTokens: 8192, agentBudgetUsd: '0.25',
    }));
    expect(await scheduleRow(id)).toMatchObject({
      jobType: 'agent_prompt',
      operation: null,
      agentModel: 'claude-sonnet-4-6',
      agentMaxTokens: 8192,
      agentBudgetUsd: '0.25',
      agentHarnessVersion: HARNESS_PIN,
    });
  });

  test('an unknown payload field is refused — and that is what keeps D5\'s Bash door shut', async () => {
    await seedAgentLane();
    const refused: Array<[string, unknown]> = [
      // There is no field for a tool allowlist, a Bash toggle, or fenced params;
      // a payload that carries one is refused as an unknown field rather than
      // stored and ignored.
      ['agentAllowedTools', ['Bash']],
      ['agentBash', true],
      ['params', { source: 'someone-elses-space' }],
      // The harness pin is derived, exactly as `source` is fenced for a command:
      // a caller cannot claim a pin it does not have.
      ['agentHarnessVersion', '0.0.1'],
    ];
    for (const [field, value] of refused) {
      const res = await hit('POST', '/api/schedules', adminCookie,
        agentBody({ name: uniqueName('bad-field'), [field]: value }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'unknown_agent_field', field });
    }
    // Refused, never stored: only the lane's own row exists.
    const rows = await getDb().select().from(schema.schedules)
      .where(eq(schema.schedules.organizationId, ORG));
    expect(rows.length).toBe(1);
  });

  test('a model absent from the pinned price table is refused at creation, not at 3am', async () => {
    await seedAgentLane();
    const res = await hit('POST', '/api/schedules', adminCookie,
      agentBody({ agentModel: 'claude-hypothetical-9' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'unpriced_model', model: 'claude-hypothetical-9', pricedAt: MODEL_PRICING.pricedAt,
    });

    // A dated id IS priced (rateFor matches it), so it is not "absent".
    expect((await hit('POST', '/api/schedules', adminCookie,
      agentBody({ agentModel: 'claude-haiku-4-5-20251001' }))).status).toBe(201);
  });

  test('an out-of-range budget or output cap is refused at creation', async () => {
    await seedAgentLane();
    for (const agentBudgetUsd of ['0', '-1', '500', '100.0000001', 'free', '', '1e3']) {
      const res = await hit('POST', '/api/schedules', adminCookie,
        agentBody({ name: uniqueName('bad-budget'), agentBudgetUsd }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_agent_budget_usd' });
    }
    for (const agentMaxTokens of [0, 12, 1_000_000, 4096.5, 'many']) {
      const res = await hit('POST', '/api/schedules', adminCookie,
        agentBody({ name: uniqueName('bad-tokens'), agentMaxTokens }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_agent_max_tokens' });
    }
    // The bounds themselves are allowed: a range probe must not be off by one.
    expect((await hit('POST', '/api/schedules', adminCookie,
      agentBody({ calendarMinute: 10, agentBudgetUsd: '0.01', agentMaxTokens: 256 }))).status).toBe(201);
    expect((await hit('POST', '/api/schedules', adminCookie,
      agentBody({ calendarMinute: 15, agentBudgetUsd: '100', agentMaxTokens: 64000 }))).status).toBe(201);
  });

  test('a command preset cannot be smuggled into an agent row', async () => {
    await seedAgentLane();
    const res = await hit('POST', '/api/schedules', adminCookie, agentBody({ preset: 'live-sync' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'preset_job_type_mismatch', preset: 'live-sync', jobType: 'agent_prompt',
    });
    // The server would otherwise drop `sync`'s params on the floor and store a
    // row shaped like neither lane.
    expect((await getDb().select().from(schema.schedules)
      .where(eq(schema.schedules.organizationId, ORG))).length).toBe(1);
  });

  test('no consumer, no schedule: `never_claimed` and `disabled` both refuse a create', async () => {
    const never = await hit('POST', '/api/schedules', adminCookie, agentBody());
    expect(never.status).toBe(409);
    const neverBody = await never.json() as { error: string; detail: string };
    expect(neverBody).toMatchObject({
      error: 'runner_not_enabled', state: 'never_claimed', lastSeenAt: null,
    });
    // D2: the refusal names the fact the gate TESTS — a sighting inside the
    // window. It must not say "nothing has claimed any agent run", which was
    // false about the running, long-polling runner this defect was found with.
    expect(neverBody.detail).not.toContain('nothing has claimed');
    expect(neverBody.detail).toContain(`${Math.round(RUNNER_SEEN_WINDOW_MS / 1000)}s`);

    await withRunnerToken('', async () => {
      const off = await hit('POST', '/api/schedules', adminCookie,
        agentBody({ name: uniqueName('disabled-lane') }));
      expect(off.status).toBe(409);
      expect(await off.json()).toMatchObject({
        error: 'runner_not_enabled', state: 'disabled', lastSeenAt: null,
      });
    });

    // The gbrain_command lane has its own consumer — the scheduler — so it is
    // not gated by the runner at all.
    expect((await hit('POST', '/api/schedules', adminCookie, intervalBody())).status).toBe(201);

    const rows = await getDb().select().from(schema.schedules)
      .where(eq(schema.schedules.organizationId, ORG));
    expect(rows.map((r) => r.jobType)).toEqual(['gbrain_command']);
  });

  // D2, the reversal this fix is FOR: a runner that is long-polling the claim
  // route has been SEEN, and the first agent schedule becomes creatable — with no
  // run in flight, and nothing but the sighting making the lane green.
  test('a runner that is seen but idle makes an agent schedule creatable', async () => {
    await recordRunnerSeen('runner-idle-0123abcd', HARNESS_PIN);

    const res = await hit('POST', '/api/schedules', adminCookie, agentBody());
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ jobType: 'agent_prompt', operation: null });
    // The row exists because the sighting does — no claim was needed, and no
    // claim happened.
    expect((await getDb().select().from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.organizationId, ORG))).length).toBe(0);

    // And the same stack refuses the moment the sighting ages out of the window:
    // the gate is the WINDOW, not "ever".
    await getDb().delete(schema.runnerPresence);
    await recordRunnerSeen(
      'runner-idle-0123abcd', HARNESS_PIN, Date.now() - RUNNER_SEEN_WINDOW_MS - 1_000,
    );
    const stale = await hit('POST', '/api/schedules', adminCookie,
      agentBody({ name: uniqueName('stale-lane') }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'runner_not_enabled', state: 'never_claimed' });
  });

  test('a runner whose lease lapsed is refused too, and the refusal says when it was last seen', async () => {
    await seedAgentLane({ leaseMs: -60_000 });
    const res = await hit('POST', '/api/schedules', adminCookie, agentBody());
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; state: string; lastSeenAt: string | null };
    expect(body.error).toBe('runner_not_enabled');
    // No fourth word exists for "configured, claimed once, lease lapsed": the
    // state is the non-green one and `lastSeenAt` is what tells them apart.
    expect(body.state).toBe('never_claimed');
    expect(body.lastSeenAt).not.toBeNull();
  });
});

describe('the timing rules are unchanged, whatever the payload shape', () => {
  test('an agent_prompt schedule is accepted under the same quiet hours a gbrain_command one is', async () => {
    const quiet = { quietHoursStart: 22, quietHoursEnd: 6 };
    expect((await hit('PATCH', '/api/org/schedule-settings', adminCookie, quiet)).status).toBe(200);
    await seedAgentLane();

    // Quiet hours HOLD output; they never refuse a create, in either lane.
    expect((await hit('POST', '/api/schedules', adminCookie,
      calendarBody(3, 5, { notifies: true }))).status).toBe(201);
    const agent = await hit('POST', '/api/schedules', adminCookie,
      agentBody({ calendarMinute: 10, notifies: true }));
    expect(agent.status).toBe(201);

    const [org] = await getDb().select().from(schema.organizations)
      .where(eq(schema.organizations.id, ORG));
    expect({ quietHoursStart: org!.quietHoursStart, quietHoursEnd: org!.quietHoursEnd }).toEqual(quiet);
    const created = await agent.json() as { id: string };
    expect(await scheduleRow(created.id)).toMatchObject({
      notifies: true, jobType: 'agent_prompt', kind: 'calendar',
    });
  });

  test('the one-sub-hourly-lane rule still refuses the second sub-hourly schedule', async () => {
    await seedAgentLane();
    // The lane is TIMING, not payload shape: an agent interval schedule takes it
    // exactly as a gbrain_command one does.
    const first = await createSchedule(agentBody({ kind: 'interval', intervalSeconds: 300 }));
    const res = await hit('POST', '/api/schedules', adminCookie, intervalBody({ intervalSeconds: 600 }));
    expect(res.status).toBe(409);
    const refusal = await res.json() as { error: string; holder?: string; detail?: string };
    expect(refusal.error).toBe('sub_hourly_limit');
    expect(refusal.holder).toBe((await scheduleRow(first)).name);
    expect(refusal.detail).toMatch(/sub-hourly/);
  });

  test('the stagger grid refuses an agent_prompt slot the way it refuses a command slot', async () => {
    await seedAgentLane();
    await createSchedule(calendarBody(3, 5));
    const res = await hit('POST', '/api/schedules', adminCookie, agentBody({ calendarMinute: 5 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'slot_taken', nextFree: 10 });
  });
});

describe('health reports the runner lane, and nothing else about it', () => {
  test('a connected lane is green on state alone, with no token, client id or claim id', async () => {
    await seedAgentLane();
    const body = await (await hit('GET', '/api/health')).json() as {
      runner: { state: string; lastSeenAt: string | null; version: string | null };
    };
    expect(body.runner.state).toBe('connected');
    expect(body.runner.lastSeenAt).not.toBeNull();
    expect(body.runner.version).toBeNull();
    // /api/health is unauthenticated: kinds and counts only, the same
    // discipline `openAlerts()` follows (S3c).
    expect(Object.keys(body.runner).sort()).toEqual(['lastSeenAt', 'state', 'version']);
    const text = JSON.stringify(body);
    expect(text).not.toContain('it-not-a-real-runner-token');
    expect(text).not.toContain('runner-test-0123abcd');
    expect(text).not.toContain(memberConn);
  });

  test('a runner-less deployment reads `disabled`, never "fine"', async () => {
    await withRunnerToken('', async () => {
      const body = await (await hit('GET', '/api/health')).json() as { runner: { state: string } };
      expect(body.runner.state).toBe('disabled');
    });
  });
});

describe('run-now and history', () => {
  test('run-now inserts a pending run with a manual slot, never a fake scheduled one', async () => {
    const id = await createSchedule(intervalBody());
    const res = await hit('POST', `/api/schedules/${id}/run-now`, adminCookie, {});
    expect(res.status).toBe(202);

    const runs = await (await hit('GET', `/api/schedules/${id}/runs`, adminCookie)).json() as {
      runs: Array<{ slot: string; state: string; fireAt: string }>;
    };
    expect(runs.runs.length).toBe(1);
    expect(runs.runs[0]!.slot).toMatch(/^manual:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(runs.runs[0]!.state).toBe('pending');

    const [stored] = await getDb().select().from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.scheduleId, id));
    expect(stored!.state).toBe('pending');
    expect(stored!.slot).toBe(runs.runs[0]!.slot);
    // Nothing materialized it: a manual run is never dressed up as a firing.
    expect(stored!.claimedBy).toBeNull();
  });

  test('run-now is idempotent within the same second', async () => {
    const id = await createSchedule(intervalBody());
    const frozen = Date.now();
    setSystemTime(frozen);
    try {
      expect((await hit('POST', `/api/schedules/${id}/run-now`, adminCookie, {})).status).toBe(202);
      const again = await hit('POST', `/api/schedules/${id}/run-now`, adminCookie, {});
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: 'duplicate_run' });
      // The UNIQUE (schedule_id, slot) index is the mechanism: one row, not two.
      const runs = await getDb().select().from(schema.scheduleRuns)
        .where(eq(schema.scheduleRuns.scheduleId, id));
      expect(runs.length).toBe(1);
    } finally {
      setSystemTime();
    }
  });

  test('run history never leaks stdout or argv values', async () => {
    const id = await createSchedule(intervalBody());
    await hit('POST', `/api/schedules/${id}/run-now`, adminCookie, {});
    // The shape the executor really persists (S3c): counts and status only.
    await getDb().update(schema.scheduleRuns)
      .set({ state: 'succeeded', classification: 'ok', exitCode: 0, summary: { changed: 3, status: 'succeeded' } })
      .where(eq(schema.scheduleRuns.scheduleId, id));

    const res = await hit('GET', `/api/schedules/${id}/runs`, adminCookie);
    const text = await res.text();
    expect(text).not.toContain('stdout');
    expect(text).not.toContain('stderr');
    expect(text).not.toContain('argv');

    const body = JSON.parse(text) as { runs: Array<Record<string, unknown>> };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0]!.summary).toEqual({ changed: 3, status: 'succeeded' });
    // The projection IS the guarantee: no log column can appear here, even if
    // one is ever added to schedule_runs.
    expect(Object.keys(body.runs[0]!).sort()).toEqual([
      'attempt', 'classification', 'createdAt', 'exitCode', 'finishedAt', 'fireAt',
      'id', 'reportPath', 'slot', 'startedAt', 'state', 'summary',
    ].sort());
  });

  test('run-now refuses a schedule that is disabled', async () => {
    const id = await insertSchedule({ enabled: false, disabledReason: 'connection_revoked' });
    const res = await hit('POST', `/api/schedules/${id}/run-now`, adminCookie, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'schedule_disabled', reason: 'connection_revoked' });
  });

  test('PATCH re-runs slot assignment on a calendar change', async () => {
    await createSchedule(calendarBody(2, 5));
    const second = await createSchedule(calendarBody(3, 5));

    const collided = await hit('PATCH', `/api/schedules/${second}`, adminCookie,
      { calendarHour: 2, calendarMinute: 5 });
    expect(collided.status).toBe(409);
    expect(await collided.json()).toMatchObject({ error: 'slot_taken', nextFree: 10 });
    expect((await scheduleRow(second)).calendarHour).toBe(3);

    const moved = await hit('PATCH', `/api/schedules/${second}`, adminCookie,
      { calendarHour: 4, calendarMinute: 7 });
    expect(moved.status).toBe(200);
    // The grid is re-applied on the way in: :07 is not assignable, :10 is.
    expect(await moved.json()).toMatchObject({
      calendarHour: 4, calendarMinute: 10, slotMinute: 10,
    });

    // Re-asserting its own slot is not a collision with itself.
    const same = await hit('PATCH', `/api/schedules/${second}`, adminCookie,
      { calendarHour: 4, calendarMinute: 10 });
    expect(same.status).toBe(200);
  });

  test('PATCH refuses a fenced param and an enabled flip is audited', async () => {
    const id = await createSchedule(intervalBody());
    const fenced = await hit('PATCH', `/api/schedules/${id}`, adminCookie, { params: { source: 'shared' } });
    expect(fenced.status).toBe(400);
    expect((await fenced.json() as { error: string }).error).toMatch(/fenced/);

    const off = await hit('PATCH', `/api/schedules/${id}`, adminCookie, { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ enabled: false, disabledReason: 'operator' });

    const on = await hit('PATCH', `/api/schedules/${id}`, adminCookie, { enabled: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ enabled: true, disabledReason: null });

    const audit = await getDb().select().from(schema.auditLog)
      .where(and(
        eq(schema.auditLog.organizationId, ORG),
        eq(schema.auditLog.action, 'schedule.update'),
        eq(schema.auditLog.target, id),
      ));
    expect(audit.length).toBe(2);
  });

  test('a member may not PATCH, DELETE or run another member\'s schedule', async () => {
    const id = await insertSchedule({ connectionId: otherConn });
    expect((await hit('PATCH', `/api/schedules/${id}`, memberCookie, { enabled: false })).status).toBe(403);
    expect((await hit('DELETE', `/api/schedules/${id}`, memberCookie)).status).toBe(403);
    expect((await hit('POST', `/api/schedules/${id}/run-now`, memberCookie, {})).status).toBe(403);
    // ...and the row is untouched.
    expect((await scheduleRow(id)).enabled).toBe(true);
  });

  test('a member may DELETE their own schedule, and its runs go with it', async () => {
    const id = await createSchedule(intervalBody({ connectionId: memberConn }));
    await hit('POST', `/api/schedules/${id}/run-now`, memberCookie, {});
    const res = await hit('DELETE', `/api/schedules/${id}`, memberCookie);
    expect(res.status).toBe(200);
    expect((await getDb().select().from(schema.schedules)
      .where(eq(schema.schedules.id, id))).length).toBe(0);
    expect((await getDb().select().from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.scheduleId, id))).length).toBe(0);
  });

  test('an unknown schedule id is a 404, never a 403 leak', async () => {
    expect((await hit('GET', `/api/schedules/${NOPE}`, adminCookie)).status).toBe(404);
    expect((await hit('GET', `/api/schedules/${NOPE}/runs`, adminCookie)).status).toBe(404);
    expect((await hit('POST', `/api/schedules/${NOPE}/run-now`, adminCookie, {})).status).toBe(404);
  });

  test('alerts can be acknowledged once, and the ack is attributed', async () => {
    const id = await insertSchedule();
    const alertId = randomUUID();
    await getDb().insert(schema.scheduleAlerts).values({
      id: alertId, organizationId: ORG, scheduleId: id, runId: null,
      kind: 'push_rejected', detail: { status: 'push_failed' },
    });

    const list = await hit('GET', '/api/schedule-alerts', viewerCookie);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ alerts: [{ id: alertId, kind: 'push_rejected' }] });

    const ack = await hit('POST', `/api/schedule-alerts/${alertId}/ack`, memberCookie, {});
    expect(ack.status).toBe(200);
    await hit('POST', `/api/schedule-alerts/${alertId}/ack`, memberCookie, {});
    const [row] = await getDb().select().from(schema.scheduleAlerts)
      .where(eq(schema.scheduleAlerts.id, alertId));
    expect(row!.acknowledgedAt).not.toBeNull();
    expect(row!.acknowledgedBy).not.toBeNull();

    expect((await hit('POST', `/api/schedule-alerts/${NOPE}/ack`, memberCookie, {})).status).toBe(404);
  });

  test('the preset catalogue names the org\'s system presets', async () => {
    const body = await (await hit('GET', '/api/schedule-presets', viewerCookie)).json() as {
      presets: Array<{ id: string; system?: boolean; operation: string | null; jobType?: string }>;
      system: string[];
    };
    expect(body.presets.filter((p) => !p.system).map((p) => p.id).sort())
      .toEqual(['autopilot-tripwire', 'live-sync', 'nightly-agent-briefing', 'nightly-dream', 'weekly-health']);
    expect(body.presets.map((p) => p.id)).toContain('morning-briefing');
    expect(body.system).toEqual([]);
    // One agent preset, and it is the only one: "don't over-cron" is the guide's
    // own advice, and a family of them is what it warns against.
    expect(body.presets.filter((p) => p.jobType === 'agent_prompt').map((p) => p.id))
      .toEqual(['nightly-agent-briefing']);

    // A `notifies` schedule is the briefing's precondition.
    await createSchedule(intervalBody({ notifies: true }));
    const after = await (await hit('GET', '/api/schedule-presets', viewerCookie)).json() as { system: string[] };
    expect(after.system).toEqual(['morning-briefing']);
  });
});

describe('revoking a Connection disables its schedules', () => {
  async function throwaway(): Promise<{ connectionId: string; scheduleId: string }> {
    const connectionId = await addConnection(ownerMembership, `bs-throwaway-${randomUUID().slice(0, 8)}`);
    const scheduleId = await insertSchedule({ connectionId, enabled: true });
    return { connectionId, scheduleId };
  }

  test('revoke sets enabled=false with a reason and raises an alert', async () => {
    const { connectionId, scheduleId } = await throwaway();
    await revokeConnection(connectionId, 'admin@example.test');

    const [row] = await getDb().select().from(schema.schedules)
      .where(eq(schema.schedules.id, scheduleId));
    expect(row!.enabled).toBe(false);
    expect(row!.disabledReason).toBe('connection_revoked');

    // Honesty rule 3: scope removals are immediate, and the alert is not
    // swallowed — it is the operator's only signal that the job stopped.
    const alerts = await alertsFor(scheduleId);
    expect(alerts.some((a) => a.kind === 'connection_revoked')).toBe(true);
    const alert = alerts.find((a) => a.kind === 'connection_revoked')!;
    expect(alert.detail).toMatchObject({ connectionId });
    expect(alert.acknowledgedAt).toBeNull();

    // The audit row is written BEFORE the disable, and both survive.
    const audit = await getDb().select().from(schema.auditLog)
      .where(and(
        eq(schema.auditLog.organizationId, ORG),
        eq(schema.auditLog.action, 'connection.revoke'),
        eq(schema.auditLog.target, connectionId),
      ));
    expect(audit.length).toBe(1);
  });

  test('one alert per disabled schedule, and enabled ones are untouched', async () => {
    const { connectionId, scheduleId } = await throwaway();
    const second = await insertSchedule({ connectionId, enabled: true });
    const alreadyOff = await insertSchedule({ connectionId, enabled: false, disabledReason: 'operator' });
    const otherConnSchedule = await insertSchedule({ connectionId: otherConn });

    await revokeConnection(connectionId, 'admin@example.test');

    expect((await alertsFor(scheduleId)).length).toBe(1);
    expect((await alertsFor(second)).length).toBe(1);
    // Already-disabled rows are not re-disabled and not re-alerted.
    expect((await alertsFor(alreadyOff)).length).toBe(0);
    expect((await alertsFor(otherConnSchedule)).length).toBe(0);
    expect((await scheduleRow(otherConnSchedule)).enabled).toBe(true);
  });

  test('the schedule is NOT deleted — the operator keeps their configuration', async () => {
    const { connectionId, scheduleId } = await throwaway();
    const before = await scheduleRow(scheduleId);
    await revokeConnection(connectionId, 'admin@example.test');

    const [after] = await getDb().select().from(schema.schedules)
      .where(eq(schema.schedules.id, scheduleId));
    expect(after).toBeDefined();
    expect(after!.name).toBe(before.name);
    expect(after!.intervalSeconds).toBe(before.intervalSeconds);
    expect(after!.params).toEqual(before.params);
    expect(after!.createdBy).toBe(before.createdBy);
    // The Connection link survives too (the FK is ON DELETE SET NULL, and the
    // Connection is retired, not deleted).
    expect(after!.connectionId).toBe(connectionId);
  });

  test('a disabled schedule materializes nothing, while an enabled one still does', async () => {
    const { connectionId, scheduleId } = await throwaway();
    const control = await insertSchedule({ connectionId: memberConn, enabled: true });

    await revokeConnection(connectionId, 'admin@example.test');
    await materializeDue(Date.now() + 7_200_000);

    expect((await getDb().select().from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.scheduleId, scheduleId))).length).toBe(0);
    // The control proves the tick really ran over that window.
    expect((await getDb().select().from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.scheduleId, control))).length).toBeGreaterThan(0);
  });

  test('the revoke also lands through the admin route', async () => {
    const { connectionId, scheduleId } = await throwaway();
    const res = await hit('POST', `/api/connections/${connectionId}/revoke`, adminCookie, {});
    expect(res.status).toBe(200);
    expect((await scheduleRow(scheduleId)).disabledReason).toBe('connection_revoked');
    expect((await alertsFor(scheduleId)).length).toBe(1);
  });

  test('a failed ops revoke disables nothing and raises nothing', async () => {
    const { connectionId, scheduleId } = await throwaway();
    callOpsHandler = (op, _params, opts) => (op === 'auth.revokeClient'
      ? { ok: false, exitCode: 1, argv: ['gbrain', 'auth', 'revokeClient'], stdout: '', stderr: 'boom', json: null }
      : defaultOk(op, opts));

    let threw = false;
    try {
      await revokeConnection(connectionId, 'admin@example.test');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The disable runs AFTER the irreversible ops step: a schedule is never
    // marked revoked, and no alert is ever raised, for a revoke that failed.
    expect((await scheduleRow(scheduleId)).enabled).toBe(true);
    expect(await alertsFor(scheduleId)).toEqual([]);
    const [conn] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, connectionId));
    expect(conn!.state).toBe('active');
    // The audit row IS written first — that is the durable record (A2/C4).
    expect((await getDb().select().from(schema.auditLog)
      .where(and(
        eq(schema.auditLog.organizationId, ORG),
        eq(schema.auditLog.action, 'connection.revoke'),
        eq(schema.auditLog.target, connectionId),
      ))).length).toBe(1);
  });
});

describe('health surfaces open alerts', () => {
  test('GET /api/health includes unacknowledged schedule alerts', async () => {
    const scheduleId = await insertSchedule();
    const marker = `LEAK-${randomUUID()}`;
    await getDb().insert(schema.scheduleAlerts).values({
      id: randomUUID(), organizationId: ORG, scheduleId, runId: null,
      kind: 'push_blocked', detail: { path: marker },
    });

    const res = await hit('GET', '/api/health');
    const text = await res.text();
    // /api/health is reachable without a session: `detail` may name a file path
    // that matched a secret scan, so it must never appear here.
    expect(text).not.toContain(marker);

    const body = JSON.parse(text) as { scheduleAlerts: Array<Record<string, unknown>> };
    expect(Array.isArray(body.scheduleAlerts)).toBe(true);
    const alert = body.scheduleAlerts.find((a) => a.kind === 'push_blocked');
    expect(alert).toBeDefined();
    expect(alert).toMatchObject({ kind: 'push_blocked', scheduleId });
    expect(Object.keys(alert!).sort()).toEqual(['at', 'id', 'kind', 'scheduleId']);
  });

  test('an acknowledged alert drops off the health strip', async () => {
    const scheduleId = await insertSchedule();
    const alertId = randomUUID();
    await getDb().insert(schema.scheduleAlerts).values({
      id: alertId, organizationId: ORG, scheduleId, runId: null, kind: 'lease_expired',
    });

    await hit('POST', `/api/schedule-alerts/${alertId}/ack`, memberCookie, {});
    const body = await (await hit('GET', '/api/health')).json() as {
      scheduleAlerts: Array<{ kind: string }>;
    };
    expect(body.scheduleAlerts.some((a) => a.kind === 'lease_expired')).toBe(false);
  });
});
