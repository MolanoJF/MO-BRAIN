/**
 * `GET /api/spend` against real Postgres (Task 11, D9).
 *
 * Seeds two runs on one Connection, one on a Connection that is then deleted,
 * and one unpriced — then asserts the report's three sections and the
 * `unattributed` row. The ops boundary is mocked to fail so the route's
 * "unreadable ledger is unknown, not zero" behavior is asserted directly:
 * `brain` is null and `coverage.brainReachable` is false, and the page still
 * answers 200 with our own numbers.
 *
 * L2: `CONTROL_DATABASE_URL` is defaulted in this file's own header.
 */
import { mock, test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??= 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
process.env.PUBLIC_URL ??= 'http://127.0.0.1:3131';

type AnyRecord = Record<string, unknown>;
type SpendRowBody = { key: string; label: string; runs: number; costUsd: number | null; unpricedRuns: number };

// The full ops surface, so the app's import graph links; `brainUsage` is the
// only one this file exercises, and it fails on purpose.
mock.module('../../src/control/opsClient.ts', () => ({
  callOps: async () => ({ ok: true, exitCode: 0, argv: [], stdout: '{}', stderr: '', json: {} }),
  brainUsage: async () => { throw new Error('ops unreachable'); },
  mcpWhoami: async () => ({ ok: false, status: 401, error: 'invalid_token' }),
  opsHealthy: async () => false,
  inspectRepos: async () => [],
  writeReport: async () => ({ relPath: '', committed: false, sha: null }),
  cancelRun: async () => ({ cancelled: false }),
  patchFilePlaneConfig: async () => {},
  commitAsMember: async () => ({ committed: false, sha: null }),
  gitRange: async () => ({ sourceId: '', before: '', after: '', commits: [], files: [] }),
  gitPathExists: async () => ({ sourceId: '', paths: [] }),
  gitRevertRange: async () => ({ reverted: false, reason: 'nothing_to_revert' }),
  putSchemaPack: async () => {},
  putSchemaPackJson: async () => {},
  readSchemaPackRaw: async () => null,
  gitImport: async () => { throw new Error("gitImport is not mocked here"); },
  gitScaffold: async () => ({ created: [], skipped: [], sha: null }),
  removeSchemaPack: async () => ({ removed: false }),
  seedSpace: async () => {},
  gitSetRemote: async (r: { url: string }) => ({ url: r.url, branch: 'main' }),
  gitClearRemote: async () => ({ removed: true }),
  resetBrainSchema: async () => {},
  pauseBrainWriters: async () => {},
  resumeBrainWriters: async () => {},
  takeGrantCredentials: async () => null,
  deleteCredentialJournal: async () => ({ deleted: true }),
  auditTail: async () => [],
  // S1: routes/files.ts imports these alongside the rest, so a mock that omits
  // them makes the whole app graph unloadable.
  gitTree: async (sourceId: string) => ({ sourceId, root: `/repos/${sourceId}`, entries: [] }),
  gitExportBundle: async () => new Response(null),
  gitReadFile: async (sourceId: string, path: string) => ({ content: '', sha: '', size: 0 }),
  gitWriteFile: async (req: { sourceId: string; path: string; content: string; expectedSha: string }) =>
    ({ committed: true, sha: 'written-sha' }),
}));

// mock.module must be registered before the app's import graph loads.
const { default: app } = await import('../../src/control/app.ts');
const { getDb, schema, runMigrations, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { eq, inArray } = await import('drizzle-orm');

pinDb();

const PASS = 'a-long-enough-password';
const RUN = randomUUID().slice(0, 8);

const ORG = `org-spend-${RUN}`;
const ORG2 = `org-spend-unpriced-${RUN}`;
const createdUsers: string[] = [];

let adminCookie = '';
let memberCookie = '';
let admin2Cookie = '';
let memberEmail = '';

let scheduleId = '';
let schedule2Id = '';

async function addUser(
  email: string,
  role: 'owner' | 'admin' | 'member' | 'viewer',
  organizationId: string,
): Promise<{ userId: string; membershipId: string }> {
  const signed = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASS, name: email }),
  });
  expect(signed.status).toBe(200);
  const [user] = await getDb().select().from(schema.users).where(eq(schema.users.email, email));
  const membershipId = randomUUID();
  await getDb().insert(schema.memberships).values({
    id: membershipId, userId: user!.id, organizationId, role,
  });
  createdUsers.push(user!.id);
  return { userId: user!.id, membershipId };
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

/** A Connection for a membership, plus its write Space. */
async function seedConnection(organizationId: string, membershipId: string, tag: string): Promise<string> {
  const spaceId = randomUUID();
  await getDb().insert(schema.spaces).values({
    id: spaceId, organizationId, sourceId: tag, name: 'Customers', kind: 'local-git',
  });
  const connectionId = randomUUID();
  await getDb().insert(schema.connections).values({
    id: connectionId, organizationId, membershipId, writeSpaceId: spaceId,
    readSpaceIds: [], harness: 'claude-code', clientName: `bs-${tag}-${RUN}`,
    profile: 'memory-writer', tokenTtl: 3600, state: 'active', provisionedAt: new Date(),
  });
  return connectionId;
}

async function seedSchedule(organizationId: string, connectionId: string, tag: string): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.schedules).values({
    id, organizationId, connectionId,
    name: `${tag}-${RUN}`, jobType: 'agent_prompt', operation: null,
    agentPrompt: 'Read the pages that changed tonight and write one briefing page.',
    agentModel: 'claude-haiku-4-5', agentMaxTokens: 4096,
    agentBudgetUsd: '5', agentHarnessVersion: '2.1.274',
    kind: 'interval', intervalSeconds: 3600, anchorAt: new Date(0), createdBy: 'test',
  });
  return id;
}

/** One finished agent run with its metered calls. `runCost` is the rollup the
 *  finish path writes; each usage row is a metered model call. */
async function seedRun(args: {
  organizationId: string;
  scheduleId: string;
  connectionId: string | null;
  model: string;
  runCost: string | null;
  usage: Array<{ model: string; cost: string | null }>;
}): Promise<string> {
  const runId = randomUUID();
  await getDb().insert(schema.scheduleRuns).values({
    id: runId, scheduleId: args.scheduleId, organizationId: args.organizationId,
    slot: `s-${runId.slice(0, 8)}`, fireAt: new Date(), state: 'succeeded',
    startedAt: new Date(), finishedAt: new Date(),
  });
  await getDb().insert(schema.agentRuns).values({
    runId, organizationId: args.organizationId, connectionId: args.connectionId,
    model: args.model, harnessVersion: '2.1.274', budgetUsd: '5',
    costUsd: args.runCost, inputTokens: 1, outputTokens: 1,
  });
  for (const [i, u] of args.usage.entries()) {
    await getDb().insert(schema.agentRunUsage).values({
      id: randomUUID(), runId, seq: i + 1, model: u.model, costUsd: u.cost,
    });
  }
  return runId;
}

beforeAll(async () => {
  await runMigrations();

  // --- ORG: two priced runs + one unpriced on A, one priced run on B which is
  // then deleted, so `on delete set null` leaves that run unattributed.
  await getDb().insert(schema.organizations).values({
    id: ORG, name: 'Spend Co', slug: `spend-${RUN}`, timezone: 'UTC',
  });
  await addUser(`spend-admin-${RUN}@example.test`, 'admin', ORG);
  const member = await addUser(`spend-member-${RUN}@example.test`, 'member', ORG);
  memberEmail = `spend-member-${RUN}@example.test`;

  const connectionA = await seedConnection(ORG, member.membershipId, 'spend-a');
  const connectionB = await seedConnection(ORG, member.membershipId, 'spend-b');
  scheduleId = await seedSchedule(ORG, connectionA, 'spend');

  await seedRun({
    organizationId: ORG, scheduleId, connectionId: connectionA,
    model: 'claude-haiku-4-5', runCost: '0.25',
    usage: [{ model: 'claude-haiku-4-5', cost: '0.25' }],
  });
  await seedRun({
    organizationId: ORG, scheduleId, connectionId: connectionA,
    model: 'claude-haiku-4-5', runCost: '0.75',
    usage: [{ model: 'claude-haiku-4-5', cost: '0.75' }],
  });
  await seedRun({
    organizationId: ORG, scheduleId, connectionId: connectionA,
    model: 'claude-haiku-4-5', runCost: null,
    usage: [{ model: 'claude-haiku-4-5', cost: null }],
  });
  await seedRun({
    organizationId: ORG, scheduleId, connectionId: connectionB,
    model: 'claude-sonnet-4-5', runCost: '0.50',
    usage: [{ model: 'claude-sonnet-4-5', cost: '0.50' }],
  });
  await getDb().delete(schema.connections).where(eq(schema.connections.id, connectionB));

  // --- ORG2: a window with nothing but unpriced runs, for the null total.
  await getDb().insert(schema.organizations).values({
    id: ORG2, name: 'Spend Unpriced', slug: `spend-unpriced-${RUN}`, timezone: 'UTC',
  });
  await addUser(`spend-admin2-${RUN}@example.test`, 'admin', ORG2);
  const member2 = await addUser(`spend-member2-${RUN}@example.test`, 'member', ORG2);
  const connection2 = await seedConnection(ORG2, member2.membershipId, 'spend-c');
  schedule2Id = await seedSchedule(ORG2, connection2, 'spend-unpriced');
  await seedRun({
    organizationId: ORG2, scheduleId: schedule2Id, connectionId: connection2,
    model: 'claude-haiku-4-5', runCost: null,
    usage: [{ model: 'claude-haiku-4-5', cost: null }],
  });

  adminCookie = await signIn(`spend-admin-${RUN}@example.test`);
  memberCookie = await signIn(memberEmail);
  admin2Cookie = await signIn(`spend-admin2-${RUN}@example.test`);
}, 90_000);

afterAll(async () => {
  await getDb().delete(schema.organizations).where(inArray(schema.organizations.id, [ORG, ORG2]));
  await getDb().delete(schema.users).where(inArray(schema.users.id, createdUsers));
  await closeDb();
});

async function getSpend(query: string, cookie: string) {
  return app.request(`/api/spend${query}`, { method: 'GET', headers: { cookie } });
}

describe('GET /api/spend (D9)', () => {
  test('rolls up per member, schedule and model, with unattributed on its own row', async () => {
    const res = await getSpend('?days=30', adminCookie);
    expect(res.status).toBe(200);
    const report = await res.json() as AnyRecord;
    const ours = report.ours as {
      totalUsd: number | null; unpricedRuns: number;
      byMember: SpendRowBody[]; bySchedule: SpendRowBody[]; byModel: SpendRowBody[];
    };

    expect(report.windowDays).toBe(30);
    // Total = the priced part; the unpriced run is counted, never zeroed.
    expect(ours.totalUsd).toBe(1.5);
    expect(ours.unpricedRuns).toBe(1);

    // byMember: the member's three runs, and unattributed never folded in.
    expect(ours.byMember).toHaveLength(2);
    const memberRow = ours.byMember.find((r) => r.key !== 'unattributed')!;
    expect(memberRow).toMatchObject({ label: memberEmail, runs: 3, costUsd: 1, unpricedRuns: 1 });
    const unattributed = ours.byMember.find((r) => r.key === 'unattributed')!;
    expect(unattributed).toMatchObject({
      label: 'Unattributed (Connection deleted)', runs: 1, costUsd: 0.5, unpricedRuns: 0,
    });

    // bySchedule: all four runs belong to the one schedule.
    expect(ours.bySchedule).toEqual([
      { key: scheduleId, label: `spend-${RUN}`, runs: 4, costUsd: 1.5, unpricedRuns: 1 },
    ]);

    // byModel: one row per model, unpriced calls counted on their own row.
    const haiku = ours.byModel.find((r) => r.key === 'claude-haiku-4-5')!;
    expect(haiku).toMatchObject({ runs: 3, costUsd: 1, unpricedRuns: 1 });
    const sonnet = ours.byModel.find((r) => r.key === 'claude-sonnet-4-5')!;
    expect(sonnet).toMatchObject({ runs: 1, costUsd: 0.5, unpricedRuns: 0 });

    // The ledger could not be read: null, never zero, and the page still answers.
    expect(report.brain).toBeNull();
    expect((report.coverage as { brainReachable: boolean }).brainReachable).toBe(false);
    expect((report.coverage as { ours: string[] }).ours.length).toBeGreaterThan(0);
  });

  test('a window where nothing could be priced has a NULL total, never 0', async () => {
    const res = await getSpend('?days=30', admin2Cookie);
    expect(res.status).toBe(200);
    const report = await res.json() as AnyRecord;
    const ours = report.ours as { totalUsd: number | null; unpricedRuns: number; byMember: SpendRowBody[] };
    expect(ours.unpricedRuns).toBe(1);
    expect(ours.totalUsd).toBeNull();
    expect(ours.byMember[0]!.costUsd).toBeNull();
  });

  test('days is clamped to 1..365 to mirror upstream', async () => {
    expect(((await (await getSpend('?days=0', adminCookie)).json()) as AnyRecord).windowDays).toBe(1);
    expect(((await (await getSpend('?days=9999', adminCookie)).json()) as AnyRecord).windowDays).toBe(365);
    expect(((await (await getSpend('', adminCookie)).json()) as AnyRecord).windowDays).toBe(30);
  });

  test('it is admin-only', async () => {
    expect((await getSpend('?days=30', memberCookie)).status).toBe(403);
    expect((await app.request('/api/spend')).status).toBe(401);
  });
});
