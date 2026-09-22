/**
 * The agent runner's whole HTTP surface, end to end, against real Postgres and a
 * fake ops (Task 6, D2/D3/D9/D11).
 *
 * Every assertion here is a behaviour the plan names, not wiring: the job-type
 * filter sends each consumer to its own lane, the long poll answers 204 rather
 * than spinning, a stolen lease is a 409, a replayed event batch inserts once,
 * `finish` revokes the run's gbrain token and stamps `token_revoked_at`, the cost
 * rollup EQUALS the sum of `agent_run_usage`, the projection carries neither
 * token, and a dead runner's run is reclaimed by the reclaimer (honesty rule 5).
 *
 * L2: `CONTROL_DATABASE_URL` is defaulted in this file's own header, never
 * required as an export.
 */
import { mock, test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??= 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
process.env.PUBLIC_URL ??= 'http://127.0.0.1:3131';
// D12: a non-empty token is the lane being ON. The `disabled` probe below moves
// it on purpose.
process.env.RUNNER_TOKEN ??= 'it-not-a-real-runner-token';
// D3: a 25s long poll is 25s of nothing in a test. Both are read per call.
process.env.RUN_CLAIM_WAIT_MS ??= '250';
process.env.RUN_CLAIM_POLL_MS ??= '25';

const RUNNER_TOKEN = process.env.RUNNER_TOKEN;
const HARNESS = '2.1.274';
const WRITE_SOURCE = 'customers';
const READ_SOURCE = 'shared';

type OpsResult = {
  ok: boolean; exitCode: number; argv: string[]; stdout: string; stderr: string; json: unknown;
};
type CallOpts = { json?: boolean; dryRun?: boolean; timeoutMs?: number };
type Range = {
  sourceId: string; before: string; after: string;
  commits: Array<{ sha: string; author: string; email: string; subject: string; at: string }>;
  files: Array<{ status: string; path: string }>;
};

/** What the fake ops recorded, so a probe can assert the CALL, not just the row. */
const ops = {
  grants: 0,
  revokedClients: [] as string[],
  journalsDeleted: [] as string[],
  commits: [] as Array<{ sourceId: string; actor: { name: string; email: string }; message: string }>,
  handoffsTaken: [] as string[],
  /** Set by a probe that wants a real range back. */
  rangeCommits: [] as Range['commits'],
  rangeFiles: [] as Range['files'],
  /** A read Space whose head moves: honesty rule 10's finding. */
  moveReadSpace: false,
  /** Head counters, so claim-time and finish-time captures differ. */
  headCalls: new Map<string, number>(),
  failRevoke: false,
  failCommit: false,
};

function resetOps(): void {
  ops.grants = 0;
  ops.revokedClients = [];
  ops.journalsDeleted = [];
  ops.commits = [];
  ops.handoffsTaken = [];
  ops.rangeCommits = [];
  ops.rangeFiles = [];
  ops.moveReadSpace = false;
  ops.headCalls.clear();
  ops.failRevoke = false;
  ops.failCommit = false;
}

function ok(json: unknown): OpsResult {
  return { ok: true, exitCode: 0, argv: ['gbrain'], stdout: '{}', stderr: '', json };
}

/** The fake ops, in full: `mock.module` must see every real export or the graph
 *  will not load (the scheduler-routes header records the same trap). */
mock.module('../../src/control/opsClient.ts', () => ({
  // `src/control/spend.ts` imports this alongside the others; a mock that
  // omits a real export makes the whole graph unloadable (Slice 4 hazard (a)).
  brainUsage: async () => { throw new Error('ops unreachable'); },
  callOps: async (op: string, params?: Record<string, unknown>, _opts?: CallOpts) => {
    if (op === 'mcp.grant') {
      ops.grants += 1;
      return ok({ client_id: `gbrain_cl_run_${ops.grants}` });
    }
    if (op === 'auth.revokeClient') {
      if (ops.failRevoke) throw new Error('ops is down');
      ops.revokedClients.push(String(params?.clientId));
      return ok({});
    }
    return ok({});
  },
  gitRange: async (sourceId: string, before: string, after: string): Promise<Range> => {
    if (before === 'HEAD' && after === 'HEAD') {
      const seen = (ops.headCalls.get(sourceId) ?? 0) + 1;
      ops.headCalls.set(sourceId, seen);
      const head = sourceId === READ_SOURCE && !ops.moveReadSpace
        ? 'sha-steady-read'
        : `sha${seen}-${sourceId}`;
      return { sourceId, before, after: head, commits: [], files: [] };
    }
    return {
      sourceId, before, after,
      commits: ops.rangeCommits, files: ops.rangeFiles,
    };
  },
  commitAsMember: async (
    sourceId: string, actor: { name: string; email: string }, message: string,
  ) => {
    if (ops.failCommit) throw new Error('git is unavailable');
    ops.commits.push({ sourceId, actor, message });
    return { committed: true, sha: `commit-${ops.commits.length}` };
  },
  takeGrantCredentials: async (path: string) => {
    ops.handoffsTaken.push(path);
    return { access_token: `gbrain-run-bearer-${ops.handoffsTaken.length}` };
  },
  deleteCredentialJournal: async (clientId: string) => {
    ops.journalsDeleted.push(clientId);
    return { deleted: true };
  },
  inspectRepos: async () => [],
  opsHealthy: async () => true,
  writeReport: async () => ({ relPath: 'reports/x.md', committed: false, sha: null }),
  cancelRun: async () => ({ cancelled: false }),
  patchFilePlaneConfig: async () => {},
  putSchemaPack: async () => {},
  putSchemaPackJson: async () => {},
  gitScaffold: async () => ({ created: [], skipped: [], sha: null }),
  removeSchemaPack: async () => ({ removed: false }),
  seedSpace: async () => {},
  resetBrainSchema: async () => {},
  auditTail: async () => [],
  gitRevertRange: async () => ({ reverted: false, reason: 'nothing_to_revert' }),
  // S1: routes/files.ts imports these alongside the rest, so a mock that omits
  // them makes the whole app graph unloadable.
  gitTree: async (sourceId: string) => ({ sourceId, root: `/repos/${sourceId}`, entries: [] }),
  gitReadFile: async (sourceId: string, path: string) => ({ content: '', sha: '', size: 0 }),
  gitWriteFile: async (req: { sourceId: string; path: string; content: string; expectedSha: string }) =>
    ({ committed: true, sha: 'written-sha' }),
}));

/** `revertRun` is Task 10's, and it is already proven there. This file proves the
 *  ROUTE: the admin gate, the actor it passes, and the `?confirm=` mapping. */
const revertCalls: Array<{ runId: string; actor: { name: string; email: string }; confirm?: string }> = [];
mock.module('../../src/agent/revert.ts', () => ({
  revertRun: async (args: {
    runId: string; actor: { name: string; email: string }; confirm?: string;
  }) => {
    revertCalls.push(args);
    if (args.confirm !== 'concurrent') {
      return {
        error: 'revert_concurrent_writers', runId: args.runId, sourceId: WRITE_SOURCE,
        commitCount: 3, foreignCommitCount: 1, foreignAuthors: ['other <other@x.test>'],
        detail: 'one of three commits was not written by this run',
      };
    }
    return {
      reverted: true, runId: args.runId, sourceId: WRITE_SOURCE,
      revertCommit: 'revert-sha', revertedAt: new Date().toISOString(),
      files: [], index: {
        sync: { argv: ['gbrain', 'sync'], exitCode: 0, stderr: '', classification: 'ok' },
        embed: { argv: ['gbrain', 'embed'], exitCode: 0, stderr: '', classification: 'ok' },
      },
    };
  },
}));

// mock.module must be registered before the app's import graph loads, so these
// are dynamic on purpose (a static import is hoisted above the mock).
const { default: app } = await import('../../src/control/app.ts');
const { getDb, schema, runMigrations, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { claimNextRun, reclaimExpiredLeases } = await import('../../src/scheduler/claim.ts');
const { recordUsage } = await import('../../src/gateway/meter.ts');
const { GBRAIN_PIN, capabilityPath } = await import('../../src/contracts/pin.ts');
const { eq, inArray, sql } = await import('drizzle-orm');

pinDb();

/**
 * D5 reads the tool catalog from `capability_snapshots` at the running pin. The
 * live stack has such a row (0.50.5.0, 136 tools); the scratch DB does not, so
 * this probe seeds the same thing the capture lane writes — from the pinned
 * contract file, which is that capture's committed output.
 */
async function seedCapabilitySnapshot(): Promise<void> {
  const catalog = await Bun.file(capabilityPath()).json() as { tools: unknown };
  await getDb().insert(schema.capabilitySnapshots).values({
    id: randomUUID(),
    gbrainVersion: GBRAIN_PIN,
    toolsJson: catalog.tools as never,
    capturedAt: new Date(),
  });
}

const PASS = 'a-long-enough-password';
const ORG = `org-${randomUUID()}`;
const RUN = randomUUID().slice(0, 8);
const createdUsers: string[] = [];

let adminCookie = '';
let viewerCookie = '';
let memberEmail = '';
let writeSpaceId = '';
let readSpaceId = '';
let connectionId = '';

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

async function signIn(email: string): Promise<string> {
  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie') ?? '';
}

/** A runner request: the bearer is the ONLY credential this lane has (D1). */
async function runnerPost(path: string, body: unknown, token: string | undefined = RUNNER_TOKEN) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
}

async function humanGet(path: string, cookie: string) {
  return app.request(path, { method: 'GET', headers: { cookie } });
}

async function humanPost(path: string, cookie: string) {
  return app.request(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' } });
}

/** Env the claim reads PER CALL, so a probe can move it without a rebuild. */
async function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

/** An `agent_prompt` schedule: `shape_matches_job_type` wants all five agent
 *  columns and a NULL operation. */
async function agentSchedule(over: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.schedules).values({
    id, organizationId: ORG, connectionId,
    name: `agent-${id.slice(0, 8)}`,
    jobType: 'agent_prompt', operation: null,
    agentPrompt: 'Read the pages that changed tonight and write one briefing page.',
    agentModel: 'claude-haiku-4-5', agentMaxTokens: 4096,
    agentBudgetUsd: '2', agentHarnessVersion: HARNESS,
    kind: 'interval', intervalSeconds: 3600, anchorAt: new Date(0),
    createdBy: 'test', ...over,
  });
  return id;
}

/**
 * A due, unclaimed agent run. `fireAt` is the epoch on purpose: `claimNextRun`
 * scans `schedule_runs` globally, and the shared DB may hold another suite's
 * pending row — being the oldest due run makes this probe deterministic without
 * weakening what it asserts.
 */
async function pendingRun(scheduleId: string, slot = `s-${randomUUID().slice(0, 8)}`): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.scheduleRuns).values({
    id, scheduleId, organizationId: ORG, slot, fireAt: new Date(0), state: 'pending',
  });
  return id;
}

async function runningRun(scheduleId: string, slot: string): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.scheduleRuns).values({
    id, scheduleId, organizationId: ORG, slot, fireAt: new Date(0), state: 'running',
    claimedBy: 'another-runner-9999', startedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 300_000),
  });
  return id;
}

const runRow = async (runId: string) =>
  (await getDb().select().from(schema.scheduleRuns).where(eq(schema.scheduleRuns.id, runId)))[0]!;

const agentRunRow = async (runId: string) =>
  (await getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.runId, runId)))[0]!;

const alerts = () => getDb().select().from(schema.scheduleAlerts)
  .where(eq(schema.scheduleAlerts.organizationId, ORG));

/** Claim through the real route, so every probe exercises the wire contract. */
async function claim(body: Record<string, unknown> = {}) {
  return runnerPost('/api/runs/claim', { runnerId: 'runner-abc12345', harnessVersion: HARNESS, ...body });
}

beforeAll(async () => {
  await runMigrations();
  await getDb().insert(schema.organizations).values({
    id: ORG, name: 'Agent Runs', slug: `agent-runs-${RUN}`, timezone: 'UTC',
  });
  await addUser(`ar-admin-${RUN}@example.test`, 'admin');
  const memberMembership = await addUser(`ar-member-${RUN}@example.test`, 'member');
  await addUser(`ar-viewer-${RUN}@example.test`, 'viewer');
  memberEmail = `ar-member-${RUN}@example.test`;

  writeSpaceId = randomUUID();
  readSpaceId = randomUUID();
  await getDb().insert(schema.spaces).values([
    { id: writeSpaceId, organizationId: ORG, sourceId: WRITE_SOURCE, name: 'Customers', kind: 'local-git' },
    { id: readSpaceId, organizationId: ORG, sourceId: READ_SOURCE, name: 'Shared', kind: 'local-git' },
  ]);

  connectionId = randomUUID();
  await getDb().insert(schema.connections).values({
    id: connectionId, organizationId: ORG, membershipId: memberMembership,
    writeSpaceId, readSpaceIds: [readSpaceId],
    harness: 'claude-code', clientName: `bs-agent-runs-${RUN}`,
    gbrainClientId: 'gbrain_cl_member', serverClientId: 'gbrain_cl_server',
    profile: 'memory-writer', tokenTtl: 3600, state: 'active', provisionedAt: new Date(),
  });

  adminCookie = await signIn(`ar-admin-${RUN}@example.test`);
  viewerCookie = await signIn(`ar-viewer-${RUN}@example.test`);
  await seedCapabilitySnapshot();
}, 90_000);

beforeEach(async () => {
  resetOps();
  revertCalls.length = 0;
  // Cascades each test's runs and agent rows away. Alerts survive their
  // schedule by design, so they are cleared explicitly.
  await getDb().delete(schema.schedules).where(eq(schema.schedules.organizationId, ORG));
  await getDb().delete(schema.scheduleAlerts).where(eq(schema.scheduleAlerts.organizationId, ORG));
  await getDb().update(schema.connections)
    .set({ state: 'active' }).where(eq(schema.connections.id, connectionId));
});

afterAll(async () => {
  await getDb().delete(schema.scheduleAlerts).where(eq(schema.scheduleAlerts.organizationId, ORG));
  await getDb().delete(schema.organizations).where(eq(schema.organizations.id, ORG));
  await getDb().delete(schema.users).where(inArray(schema.users.id, createdUsers));
  await closeDb();
});

describe('the claim (D2, D3)', () => {
  test('an agent_prompt row is claimable by /api/runs/claim, and a gbrain_command row is not', async () => {
    const agent = await agentSchedule();
    const agentRunId = await pendingRun(agent);
    // The command lane's own fixture, OLDER than nothing but still pending: the
    // runner must not touch it.
    const commandSchedule = randomUUID();
    await getDb().insert(schema.schedules).values({
      id: commandSchedule, organizationId: ORG, connectionId,
      name: `cmd-${commandSchedule.slice(0, 8)}`, operation: 'sync',
      kind: 'interval', intervalSeconds: 3600, anchorAt: new Date(0), createdBy: 'test',
    });
    const commandRunId = await pendingRun(commandSchedule);

    const res = await claim();
    expect(res.status).toBe(200);
    const body = await res.json() as { runId: string; attempt: number; allowedTools: string[] };
    expect(body.runId).toBe(agentRunId);
    expect(body.attempt).toBe(1);
    // The claim's own filters, asserted as behaviour rather than as SQL.
    expect(body.allowedTools).toContain('mcp__gbrain__put_page');
    // F11: `delete_page` IS in the pin's catalog and in the grant's
    // `allowedOperations`, and is NOT on the granted surface — the product
    // allowlist is what keeps it out, and the intersection is what keeps a tool
    // upstream removed from lingering as a dangling grant.
    expect(body.allowedTools).not.toContain('mcp__gbrain__delete_page');
    expect(body.allowedTools).toEqual([
      'mcp__gbrain__get_backlinks',
      'mcp__gbrain__get_page',
      'mcp__gbrain__list_pages',
      'mcp__gbrain__put_page',
      'mcp__gbrain__query',
      'mcp__gbrain__search',
      'mcp__gbrain__traverse_graph',
    ]);
    expect((await runRow(commandRunId)).state).toBe('pending');
    expect((await runRow(agentRunId)).claimedBy).toBe('runner-abc12345');

    // ...and the other consumer's half of the filter, in the same database.
    const byScheduler = await claimNextRun('scheduler-worker', Date.now(), {
      jobTypes: ['gbrain_command'],
    });
    expect(byScheduler === 'none' ? null : byScheduler.run.id).toBe(commandRunId);
  });

  test('the response is D3\'s whole shape: tokens, tools, budget, lease and nothing else', async () => {
    const scheduleId = await agentSchedule();
    const runId = await pendingRun(scheduleId);
    const res = await claim();
    const claimBody = await res.json() as Record<string, unknown>;

    expect(claimBody).toMatchObject({
      runId,
      scheduleId,
      attempt: 1,
      prompt: 'Read the pages that changed tonight and write one briefing page.',
      model: 'claude-haiku-4-5',
      maxTokens: 4096,
      harnessVersion: HARNESS,
      budgetUsd: 2,
      timeoutSeconds: 900,
    });
    expect(claimBody.mcp).toEqual({
      url: `${process.env.PUBLIC_URL}/mcp`,
      token: 'gbrain-run-bearer-1',
    });
    expect(claimBody.gateway).toMatchObject({ url: 'http://control-plane:3150/api/gateway' });
    expect(typeof (claimBody.gateway as { token: string }).token).toBe('string');
    expect(new Date(String(claimBody.leaseExpiresAt)).getTime()).toBeGreaterThan(Date.now());

    // The row the reclaimer needs: the client id, and the pre-run heads (D8, D9).
    const row = await agentRunRow(runId);
    expect(row.gbrainClientId).toBe('gbrain_cl_run_1');
    expect(row.headsBefore).toMatchObject({ [WRITE_SOURCE]: expect.any(String) });
    expect(row.costUsd).toBeNull(); // nothing metered yet is not "cost 0"
  });

  test('the claim hands the runner RUNNER_MCP_ORIGIN when set, PUBLIC_URL when not (D6)', async () => {
    // D6: the runner dials gbrain over runner-net, where the public origin can
    // be unreachable — with DOMAIN=localhost, /etc/hosts inside the runner maps
    // `localhost` to the runner's OWN loopback, so https://localhost/mcp hits
    // the runner itself. Compose therefore posts an internal name instead.
    // Asserted through the route, because the URL is a wire contract: the
    // runner is handed it and dials it verbatim.
    const urlFor = async (origin: string | undefined) => {
      // Every claim leaves a live write-Space lease behind, and D9's
      // single-flight refuses the next one (`write_space_busy`) while it lives.
      // So each case does what `beforeEach` does: cascade this test's runs away
      // first, then hand the claim one fresh pending run.
      await getDb().delete(schema.schedules).where(eq(schema.schedules.organizationId, ORG));
      await pendingRun(await agentSchedule());
      return withEnv('RUNNER_MCP_ORIGIN', origin, async () => {
        const res = await claim();
        expect(res.status).toBe(200);
        const body = await res.json() as { mcp: { url: string } };
        return body.mcp.url;
      });
    };

    // Unset: exactly the public origin, which is what every deployment that
    // does not set this variable gets — unchanged.
    expect(await urlFor(undefined)).toBe(`${process.env.PUBLIC_URL}/mcp`);

    // Set: the origin the runner was told it can dial. A trailing slash and an
    // origin that already ends in `/mcp` both normalise, so a compose value
    // cannot become `https://caddy//mcp` or `https://caddy/mcp/mcp`.
    expect(await urlFor('https://caddy')).toBe('https://caddy/mcp');
    expect(await urlFor('https://caddy/')).toBe('https://caddy/mcp');
    expect(await urlFor('https://caddy/mcp')).toBe('https://caddy/mcp');

    // Empty is "unset", never a relative url: an interpolated-but-blank
    // variable must not silently degrade the origin to nothing.
    expect(await urlFor('')).toBe(`${process.env.PUBLIC_URL}/mcp`);
    // Five REAL claims against real Postgres, each one a full mint + heads
    // capture, so the per-test default (5s) is the wrong budget for this one.
  }, 60_000);

  test('an empty lane long-polls to 204 rather than 404 or a spin', async () => {
    const started = Date.now();
    const res = await claim();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    // It WAITED: a busy loop would return in ~0ms and hammer the DB.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  test('an empty RUNNER_TOKEN never authenticates, and a wrong bearer is a 401', async () => {
    await agentSchedule();
    await withEnv('RUNNER_TOKEN', undefined, async () => {
      const res = await claim();
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'runner_disabled' });
    });
    // The empty string is the shape compose interpolates on a runner-less
    // deployment; two empty strings would pass `timingSafeEqual`, so it must be
    // refused BEFORE the comparison.
    await withEnv('RUNNER_TOKEN', '', async () => {
      expect((await claim()).status).toBe(503);
    });
    const wrong = await runnerPost('/api/runs/claim', { runnerId: 'r', harnessVersion: HARNESS }, 'not-the-token');
    expect(wrong.status).toBe(401);
    // The human routes are not this lane's: no session, no run list.
    expect((await app.request('/api/runs')).status).toBe(401);
  });

  test('a claim that names no runner is refused without consuming the run', async () => {
    const scheduleId = await agentSchedule();
    const runId = await pendingRun(scheduleId);
    const res = await claim({ runnerId: '   ' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'runner_never_seen', runId: null });
    // Still claimable: a caller bug must not burn a scheduled occurrence.
    expect((await runRow(runId)).state).toBe('pending');
  });

  test('a claim that reports no harness version is refused before anything is minted', async () => {
    const scheduleId = await agentSchedule();
    await pendingRun(scheduleId);
    const res = await claim({ harnessVersion: '' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'harness_version_required' });
    expect(ops.grants).toBe(0);
  });

  test('an inactive Connection is a refusal, and the occurrence is consumed as `refused`', async () => {
    const scheduleId = await agentSchedule();
    const runId = await pendingRun(scheduleId);
    await getDb().update(schema.connections)
      .set({ state: 'pending' }).where(eq(schema.connections.id, connectionId));

    const res = await claim();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'connection_inactive', runId, scheduleId, connectionState: 'pending',
    });
    expect(ops.grants).toBe(0); // never minted a credential for a dead Connection
    const row = await runRow(runId);
    expect(row).toMatchObject({ state: 'failed', classification: 'refused' });
    // D11: `refused` is never retried — a retry cannot fix a precondition.
    const retries = await getDb().select().from(schema.scheduleRuns)
      .where(sql`${schema.scheduleRuns.scheduleId} = ${scheduleId} and ${schema.scheduleRuns.slot} like '%#r%'`);
    expect(retries).toEqual([]);
  });

  test('D9 single-flight: a second agent run cannot claim while one holds the write Space', async () => {
    const holderSchedule = await agentSchedule();
    const holderRun = await runningRun(holderSchedule, 'holder');
    const scheduleId = await agentSchedule();
    const runId = await pendingRun(scheduleId);

    const res = await claim();
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; holder: { runId: string } };
    expect(body.error).toBe('write_space_busy');
    expect(body.holder.runId).toBe(holderRun);
    expect((await runRow(runId)).classification).toBe('refused');
  });

  test('a harness pin mismatch refuses the run instead of silently downgrading', async () => {
    const scheduleId = await agentSchedule();
    const runId = await pendingRun(scheduleId);
    const res = await claim({ harnessVersion: '0.0.1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'harness_pin_mismatch', runId,
      expectedHarnessVersion: HARNESS, runnerHarnessVersion: '0.0.1',
    });
    // Org-level on purpose: the mismatch is between two deployments' pins.
    const raised = (await alerts()).filter((a) => a.kind === 'harness_pin_mismatch');
    expect(raised).toHaveLength(1);
    expect(raised[0]!.scheduleId).toBeNull();
    expect((await runRow(runId)).classification).toBe('refused');
  });
});

describe('heartbeat (D3)', () => {
  test('renews the lease, then 409s once it is stolen, and 409s a cancellation', async () => {
    const scheduleId = await agentSchedule();
    const runId = await pendingRun(scheduleId);
    await claim();

    const beat = await runnerPost(`/api/runs/${runId}/heartbeat`, { runnerId: 'runner-abc12345' });
    expect(beat.status).toBe(200);
    const first = await beat.json() as { ok: boolean; leaseExpiresAt: string };
    expect(first.ok).toBe(true);
    expect(new Date(first.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now());

    // Stolen: another runner's id on the row is the whole of the evidence.
    await getDb().update(schema.scheduleRuns)
      .set({ claimedBy: 'another-runner-9999' }).where(eq(schema.scheduleRuns.id, runId));
    const stolen = await runnerPost(`/api/runs/${runId}/heartbeat`, { runnerId: 'runner-abc12345' });
    expect(stolen.status).toBe(409);
    expect(await stolen.json()).toMatchObject({ error: 'lease_lost', state: 'running' });

    // Cancelled: `kill_previous` marks the victim while its harness is alive.
    await getDb().update(schema.scheduleRuns)
      .set({ claimedBy: 'runner-abc12345', cancelRequested: true })
      .where(eq(schema.scheduleRuns.id, runId));
    const cancelled = await runnerPost(`/api/runs/${runId}/heartbeat`, { runnerId: 'runner-abc12345' });
    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({ error: 'cancel_requested' });

    const unknown = await runnerPost(`/api/runs/${randomUUID()}/heartbeat`, { runnerId: 'runner-abc12345' });
    expect(unknown.status).toBe(404);
  });
});

describe('events (D2)', () => {
  test('a replayed batch inserts once, and says so', async () => {
    const scheduleId = await agentSchedule();
    const runId = await pendingRun(scheduleId);
    await claim();

    const batch = {
      events: [
        { seq: 1, kind: 'assistant', data: { tool: 'mcp__gbrain__put_page' } },
        { seq: 2, kind: 'result', data: { is_error: false } },
      ],
    };
    const first = await runnerPost(`/api/runs/${runId}/events`, batch);
    expect(await first.json()).toMatchObject({ ok: true, inserted: 2, replayed: 0 });

    // The same batch again: a retry after a blip must not double the receipt.
    const replay = await runnerPost(`/api/runs/${runId}/events`, batch);
    expect(await replay.json()).toMatchObject({ ok: true, inserted: 0, replayed: 2 });

    const stored = await getDb().select().from(schema.agentRunEvents)
      .where(eq(schema.agentRunEvents.runId, runId));
    expect(stored).toHaveLength(2);
    expect(stored.map((e) => e.kind).sort()).toEqual(['assistant', 'result']);

    const bad = await runnerPost(`/api/runs/${runId}/events`, { events: [{ seq: 'one', kind: 'x' }] });
    expect(bad.status).toBe(400);
    const missing = await runnerPost(`/api/runs/${randomUUID()}/events`, batch);
    expect(missing.status).toBe(404);
  });

  test('a seq repeated inside ONE batch collapses to its last frame without dropping a neighbour', async () => {
    const scheduleId = await agentSchedule();
    const runId = await pendingRun(scheduleId);
    await claim();

    const res = await runnerPost(`/api/runs/${runId}/events`, {
      events: [
        { seq: 1, kind: 'assistant' },
        { seq: 2, kind: 'assistant' },
        { seq: 1, kind: 'result', data: { late: true } },
      ],
    });
    expect(await res.json()).toMatchObject({ ok: true, inserted: 2, replayed: 0 });
    const stored = await getDb().select().from(schema.agentRunEvents)
      .where(eq(schema.agentRunEvents.runId, runId));
    expect(stored.map((e) => e.seq).sort()).toEqual([1, 2]);
    // The LAST frame for that seq is the one kept: the ledger's order must not
    // depend on what Postgres happened to do with two rows of one key.
    expect(stored.find((e) => e.seq === 1)!.kind).toBe('result');
  });
});

describe('finish (D9, D11, honesty rules 1, 3, 9, 10)', () => {
  /** A claimed run with two metered calls, so the rollup has something to sum. */
  async function claimedRun(over: Record<string, unknown> = {}) {
    const scheduleId = await agentSchedule(over);
    const runId = await pendingRun(scheduleId);
    const res = await claim();
    expect(res.status).toBe(200);
    const body = await res.json() as { mcp: { token: string }; gateway: { token: string } };
    await recordUsage({
      runId, model: 'claude-haiku-4-5', costUsd: 0.0012345,
      counts: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWrite5mTokens: 40, cacheWrite1hTokens: 0 },
    });
    await recordUsage({
      runId, model: 'claude-haiku-4-5', costUsd: 0.002,
      counts: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWrite5mTokens: 4, cacheWrite1hTokens: 0 },
    });
    return { scheduleId, runId, claim: body };
  }

  test('it commits the writes, revokes the token, records the diff and rolls the cost up', async () => {
    const { runId } = await claimedRun();
    ops.rangeCommits = [{
      sha: 'c1', author: 'Member', email: memberEmail, subject: 'agent run', at: '2026-09-17T00:00:00Z',
    }];
    ops.rangeFiles = [{ status: 'A', path: 'briefing.md' }];

    const res = await runnerPost(`/api/runs/${runId}/finish`, {
      runnerId: 'runner-abc12345', exitCode: 0, errorFrames: 0, numTurns: 3,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      result: {
        state: string; classification: string; failureClass: string | null;
        costUsd: string | null; numTurns: number; tokenRevoked: boolean;
        commit: { committed: boolean } | null;
        diff: { write: { commits: unknown[]; files: unknown[]; concurrentWriters: boolean } } | null;
        retry: unknown;
      };
    };
    expect(body.result).toMatchObject({
      state: 'succeeded',
      classification: 'ok',
      failureClass: null,
      numTurns: 3,
      tokenRevoked: true,
      commit: { committed: true },
    });

    // (c) the commit is OURS and names the run (P8: an MCP write commits nothing).
    expect(ops.commits).toEqual([{
      sourceId: WRITE_SOURCE,
      actor: { name: memberEmail, email: memberEmail },
      message: `agent run ${runId}`,
    }]);

    // (b) the token is revoked at the ops door AND stamped on the row.
    expect(ops.revokedClients).toEqual(['gbrain_cl_run_1']);
    expect(ops.journalsDeleted).toEqual(['gbrain_cl_run_1']);
    expect((await agentRunRow(runId)).tokenRevokedAt).toBeInstanceOf(Date);

    // (d) the diff is the range our own commit made real.
    expect(body.result.diff!.write.commits).toHaveLength(1);
    expect(body.result.diff!.write.files).toHaveLength(1);
    expect(body.result.diff!.write.concurrentWriters).toBe(false);

    // (e) THE ROLLUP: `agent_runs.cost_usd` EQUALS the sum, computed not accumulated.
    const [sum] = await getDb().select({
      total: sql<string | null>`sum(cost_usd::numeric)::text`,
      tokens: sql<number>`coalesce(sum(input_tokens), 0)::int`,
    }).from(schema.agentRunUsage).where(eq(schema.agentRunUsage.runId, runId));
    const row = await agentRunRow(runId);
    expect(row.costUsd).toBe(sum!.total);
    expect(row.costUsd).toBe('0.0032345');
    expect(row.inputTokens).toBe(sum!.tokens);
    expect(row.cacheReadTokens).toBe(33);
    expect(row.cacheWriteTokens).toBe(44);

    // (f) the ledger agrees, and no retry row exists for a run that succeeded.
    expect(await runRow(runId)).toMatchObject({ state: 'succeeded', classification: 'ok' });
    expect(body.result.retry).toBeNull();
  });

  test('error frames on a zero exit are `agent_failed`, and a moved read Space is a finding', async () => {
    const { runId } = await claimedRun();
    ops.moveReadSpace = true;

    const res = await runnerPost(`/api/runs/${runId}/finish`, {
      runnerId: 'runner-abc12345', exitCode: 0, errorFrames: 1,
    });
    const body = await res.json() as { result: { failureClass: string; classification: string } };
    expect(body.result.failureClass).toBe('agent_failed');
    expect(body.result.classification).toBe('agent_failed');
    expect((await agentRunRow(runId)).failureClass).toBe('agent_failed');
    expect(await runRow(runId)).toMatchObject({ state: 'failed', classification: 'agent_failed' });

    const raised = await alerts();
    expect(raised.some((a) => a.kind === 'agent_run_failed')).toBe(true);
    // Honesty rule 10: the read Space moving is an ALERT, never a diff row.
    const moved = raised.find((a) => a.kind === 'agent_read_space_moved');
    expect(moved!.scheduleId).toBeNull();
    expect(moved!.detail).toMatchObject({ moves: [{ sourceId: READ_SOURCE }] });
  });

  test('a non-zero exit is `agent_failed`, and an `infra_failed` run is retried as a NEW row', async () => {
    const { scheduleId, runId } = await claimedRun();
    // -1 is the runner's report that no process ever produced an exit code.
    const res = await runnerPost(`/api/runs/${runId}/finish`, {
      runnerId: 'runner-abc12345', exitCode: -1,
    });
    const body = await res.json() as { result: { failureClass: string; retry: { runId: string; attempt: number } | null } };
    expect(body.result.failureClass).toBe('infra_failed');
    expect(body.result.retry).toMatchObject({ attempt: 2 });

    // D11: a NEW row, so UNIQUE (schedule_id, slot) still holds and the failed
    // attempt stays in history rather than being overwritten.
    const failed = await runRow(runId);
    expect(failed).toMatchObject({ attempt: 1, state: 'failed', classification: 'infra_failed' });
    const retry = await runRow(body.result.retry!.runId);
    expect(retry).toMatchObject({
      scheduleId, attempt: 2, state: 'pending', classification: null,
      slot: `${failed.slot}#r2`,
    });
  });

  test('the meter\'s classification is never overwritten, and never re-alerted', async () => {
    const { runId } = await claimedRun();
    // Task 7 writes both of these before the harness is reaped; D11 must not
    // retry a run the meter refused to fund, and the operator already has the alert.
    await getDb().update(schema.agentRuns)
      .set({ failureClass: 'budget_exceeded' }).where(eq(schema.agentRuns.runId, runId));
    await getDb().update(schema.scheduleRuns)
      .set({ classification: 'budget_exceeded' }).where(eq(schema.scheduleRuns.id, runId));

    const res = await runnerPost(`/api/runs/${runId}/finish`, {
      runnerId: 'runner-abc12345', exitCode: 0,
    });
    const body = await res.json() as { result: { failureClass: string; retry: unknown } };
    expect(body.result.failureClass).toBe('budget_exceeded');
    expect(body.result.retry).toBeNull();
    expect(await runRow(runId)).toMatchObject({ classification: 'budget_exceeded' });
    expect((await alerts()).some((a) => a.kind === 'agent_run_failed')).toBe(false);
  });

  test('a late finish from a dead runner does not overwrite the reclaimer\'s verdict', async () => {
    const { runId } = await claimedRun();
    await getDb().update(schema.scheduleRuns)
      .set({ state: 'lease_expired', classification: 'infra_failed' })
      .where(eq(schema.scheduleRuns.id, runId));

    const late = await runnerPost(`/api/runs/${runId}/finish`, {
      runnerId: 'runner-abc12345', exitCode: 0,
    });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: 'run_not_finished', state: 'lease_expired' });
    expect(await runRow(runId)).toMatchObject({ classification: 'infra_failed' });

    // A different runner's finish for a live run is the same class of claim as a
    // lost heartbeat.
    const other = await runnerPost(`/api/runs/${runId}/finish`, {
      runnerId: 'someone-else', exitCode: 0,
    });
    expect(await other.json()).toMatchObject({ error: 'run_not_finished' });
    const unknown = await runnerPost(`/api/runs/${randomUUID()}/finish`, {
      runnerId: 'runner-abc12345', exitCode: 0,
    });
    expect(unknown.status).toBe(404);
  });
});

describe('the reclaimer (honesty rules 5 and 9)', () => {
  test('a dead runner\'s run is infra_failed and its gbrain token is revoked BY THE RECLAIMER', async () => {
    const scheduleId = await agentSchedule({ timeoutSeconds: 60 });
    const runId = await pendingRun(scheduleId);
    await claim();
    // The lease lapses with the runner still "running".
    await getDb().update(schema.scheduleRuns)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.scheduleRuns.id, runId));

    expect(await reclaimExpiredLeases(Date.now())).toBe(1);

    expect(await runRow(runId)).toMatchObject({
      state: 'lease_expired', classification: 'infra_failed',
    });
    const row = await agentRunRow(runId);
    expect(row.failureClass).toBe('infra_failed');
    expect(row.failureDetail).toMatchObject({ reason: 'lease_expired' });
    // The process that died does not get to revoke it.
    expect(ops.revokedClients).toEqual(['gbrain_cl_run_1']);
    expect(row.tokenRevokedAt).toBeInstanceOf(Date);
    expect((await alerts()).some((a) => a.kind === 'lease_expired')).toBe(true);
  });

  test('a failing revoke does not lose the reclaim: the classification survives and the alert says what broke', async () => {
    const scheduleId = await agentSchedule({ timeoutSeconds: 60 });
    const runId = await pendingRun(scheduleId);
    await claim();
    ops.failRevoke = true;
    await getDb().update(schema.scheduleRuns)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.scheduleRuns.id, runId));

    expect(await reclaimExpiredLeases(Date.now())).toBe(1);
    expect(await runRow(runId)).toMatchObject({ classification: 'infra_failed' });
    const row = await agentRunRow(runId);
    expect(row.failureClass).toBe('infra_failed');
    // `revokeRunToken` releases its claim when ops refuses, so a later attempt
    // can still kill the credential rather than a stamp vetoing the retry.
    expect(row.tokenRevokedAt).toBeNull();

    const alert = (await alerts()).find((a) => a.kind === 'lease_expired');
    expect(alert!.detail).toMatchObject({ tokenRevokeError: 'ops is down' });
  });
});

describe('the projection is the contract (honesty rule 11)', () => {
  test('the detail returns prompt, events, usage and diff — and neither token', async () => {
    const scheduleId = await agentSchedule();
    const runId = await pendingRun(scheduleId);
    const claimed = await claim();
    const tokens = await claimed.json() as {
      mcp: { url: string; token: string }; gateway: { url: string; token: string };
    };
    await runnerPost(`/api/runs/${runId}/events`, {
      events: [{ seq: 1, kind: 'assistant', data: { block: 'tool_use' } }],
    });
    await recordUsage({
      runId, model: 'claude-haiku-4-5', costUsd: 0.0005,
      counts: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 },
    });
    await runnerPost(`/api/runs/${runId}/finish`, { runnerId: 'runner-abc12345', exitCode: 0 });

    const res = await humanGet(`/api/runs/${runId}`, viewerCookie);
    expect(res.status).toBe(200);
    const text = await res.text();
    const detail = JSON.parse(text) as Record<string, unknown>;

    expect(detail.runId).toBe(runId);
    expect(detail.prompt).toBe('Read the pages that changed tonight and write one briefing page.');
    expect(detail.events).toHaveLength(1);
    expect(detail.usage).toHaveLength(1);
    expect(detail).toHaveProperty('diff');
    // `recordUsage` writes seven decimal places, and the rollup is the SUM of
    // those values — not a re-rendering of them.
    expect(detail.costUsd).toBe('0.0005000');

    // The two secrets a runner holds, and the shape of the claim that carried
    // them, must not be reachable from any projection.
    expect(text).not.toContain(tokens.mcp.token);
    expect(text).not.toContain(tokens.gateway.token);
    expect(text).not.toContain(tokens.mcp.url);
    expect(text).not.toContain('"access_token"');
    for (const key of ['token', 'accessToken', 'gatewayToken', 'mcp', 'gateway']) {
      expect(Object.keys(detail)).not.toContain(key);
    }
  });

  test('the list view is the agent lane, org-scoped, and a viewer may read it', async () => {
    const scheduleId = await agentSchedule();
    const runId = await pendingRun(scheduleId);
    await claim();

    const res = await humanGet('/api/runs', viewerCookie);
    expect(res.status).toBe(200);
    const body = await res.json() as { runs: Array<{ runId: string; scheduleId: string }> };
    expect(body.runs.map((r) => r.runId)).toContain(runId);
    expect(body.runs.every((r) => r.scheduleId === scheduleId)).toBe(true);

    // A run id that is not this org's is not reachable at all.
    expect((await humanGet(`/api/runs/${randomUUID()}`, viewerCookie)).status).toBe(404);
  });

  test('revert is an admin action, and the refusal is rendered as a choice', async () => {
    const scheduleId = await agentSchedule();
    const runId = await pendingRun(scheduleId);
    await claim();

    expect((await humanPost(`/api/runs/${runId}/revert`, viewerCookie)).status).toBe(403);

    const refused = await humanPost(`/api/runs/${runId}/revert`, adminCookie);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: 'revert_concurrent_writers', commitCount: 3, foreignCommitCount: 1,
    });
    // D10: a named human, and the second confirmation is a query flag.
    expect(revertCalls[0]!.actor.email).toBe(`ar-admin-${RUN}@example.test`);
    expect(revertCalls[0]!.confirm).toBeUndefined();

    const confirmed = await app.request(`/api/runs/${runId}/revert?confirm=concurrent`, {
      method: 'POST', headers: { cookie: adminCookie },
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ reverted: true, revertCommit: 'revert-sha' });
    expect(revertCalls[1]!.confirm).toBe('concurrent');
  });
});
