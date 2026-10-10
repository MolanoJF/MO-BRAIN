import { test, expect, describe, beforeAll, beforeEach, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, pinDb, runMigrations, schema } from '../../src/control/db/client.ts';
import { executeRun, type ExecuteDeps } from '../../src/scheduler/execute.ts';
import type { ClaimedRun } from '../../src/scheduler/claim.ts';
import type { writeReport } from '../../src/control/opsClient.ts';

/**
 * The executor against a REAL control DB with STUBBED ExecuteDeps: no gbrain,
 * no ops RPC, no spend. Gate A/B cover the real lane.
 *
 * Every occurrence is built by hand instead of through `claimNextRun`, because
 * that scan is global over `schedule_runs` and this DB is shared with the other
 * integration suites — a claimed row could belong to a neighbour's fixture.
 */
const ORG = `org-${randomUUID()}`;
const USER = `user-${randomUUID()}`;
const MEMBERSHIP = `mem-${randomUUID()}`;
/** The Connection's write Space. A second Space in the org is the decoy. */
const SPACE = `space-${randomUUID()}`;
const DECOY = `space-${randomUUID()}`;
const CONNECTION = `conn-${randomUUID()}`;
const SOURCE_ID = 'shared';
const DECOY_SOURCE_ID = 'other';

/** 2026-09-15T07:00Z — 03:00 in America/New_York: inside the 23:00-08:00 gate. */
const QUIET_MS = Date.UTC(2026, 8, 15, 7, 0);
/** 2026-09-15T14:00Z — 10:00 local: outside it. */
const AWAKE_MS = Date.UTC(2026, 8, 15, 14, 0);

type WriteArgs = Parameters<typeof writeReport>[0];
type OpOpts = { json?: boolean; dryRun?: boolean; timeoutMs?: number; runId?: string };
type StepResponse = { exitCode: number; json?: unknown; stdout?: string; stderr?: string };

beforeAll(async () => {
  pinDb();
  await runMigrations();
  const db = getDb();
  await db.insert(schema.users).values({ id: USER, name: 'Exec Member', email: `exec-${USER}@test.local` });
  await db.insert(schema.organizations).values({
    id: ORG, name: 'Executor', slug: `exec-${randomUUID().slice(0, 8)}`,
    timezone: 'America/New_York', quietHoursStart: 23, quietHoursEnd: 8,
  });
  await db.insert(schema.memberships).values({ id: MEMBERSHIP, userId: USER, organizationId: ORG, role: 'member' });
  await db.insert(schema.spaces).values([
    { id: SPACE, organizationId: ORG, sourceId: SOURCE_ID, name: 'Shared' },
    { id: DECOY, organizationId: ORG, sourceId: DECOY_SOURCE_ID, name: 'Decoy' },
  ]);
  await db.insert(schema.connections).values({
    id: CONNECTION, organizationId: ORG, membershipId: MEMBERSHIP, writeSpaceId: SPACE,
    harness: 'claude-code', clientName: 'bs-abc12345-shared', profile: 'default',
    tokenTtl: 3600, state: 'active',
  });
});

afterAll(async () => {
  // Cascades schedules, runs, alerts and held notifications away with the org.
  await getDb().delete(schema.organizations).where(eq(schema.organizations.id, ORG));
  await getDb().delete(schema.users).where(eq(schema.users.id, USER));
  await closeDb();
});

beforeEach(async () => {
  await getDb().delete(schema.schedules).where(eq(schema.schedules.organizationId, ORG));
  await getDb().delete(schema.scheduleAlerts).where(eq(schema.scheduleAlerts.organizationId, ORG));
  await getDb().delete(schema.heldNotifications).where(eq(schema.heldNotifications.organizationId, ORG));
});

async function connection(over: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.connections).values({
    id, organizationId: ORG, membershipId: MEMBERSHIP, writeSpaceId: SPACE,
    harness: 'claude-code', clientName: `bs-${id.slice(0, 8)}-shared`, profile: 'default',
    tokenTtl: 3600, state: 'active', ...over,
  });
  return id;
}

async function schedule(over: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await getDb().insert(schema.schedules).values({
    id, organizationId: ORG, connectionId: CONNECTION, name: `exec-${id.slice(0, 8)}`,
    operation: 'sync', kind: 'interval', intervalSeconds: 300,
    anchorAt: new Date(QUIET_MS), reportPolicy: 'always', timeoutSeconds: 60,
    createdBy: 'test', ...over,
  });
  return id;
}

/** The pair `claimNextRun` would have handed the worker. */
async function occurrence(
  scheduleId: string, opts: { slot: string; fireAtMs: number; nowMs: number },
): Promise<ClaimedRun> {
  const db = getDb();
  const id = randomUUID();
  await db.insert(schema.scheduleRuns).values({
    id, scheduleId, organizationId: ORG, slot: opts.slot, fireAt: new Date(opts.fireAtMs),
    state: 'running', claimedBy: 'worker-test', startedAt: new Date(opts.nowMs),
    leaseExpiresAt: new Date(opts.nowMs + 600_000),
  });
  const [run] = await db.select().from(schema.scheduleRuns).where(eq(schema.scheduleRuns.id, id));
  const [sched] = await db.select().from(schema.schedules).where(eq(schema.schedules.id, scheduleId));
  return { run: run!, schedule: sched! };
}

function harness(respond: (op: string) => StepResponse | Promise<StepResponse>, clockMs: number) {
  const captured: { op: string; params: Record<string, unknown>; opts: OpOpts }[] = [];
  const writes: WriteArgs[] = [];

  const callOpsStub = async (
    op: string, params: Record<string, unknown> = {}, opts: OpOpts = {},
  ) => {
    captured.push({ op, params: { ...params }, opts });
    const r = await respond(op);
    return {
      ok: r.exitCode === 0, exitCode: r.exitCode, argv: [] as string[],
      stdout: r.stdout ?? '', stderr: r.stderr ?? '', json: r.json ?? null,
    };
  };

  const deps: ExecuteDeps = {
    now: () => clockMs,
    cancelRun: async () => ({ cancelled: false }),
    writeReport: (async (args: WriteArgs) => {
      writes.push(args);
      return { relPath: `reports/${args.job}/${args.stamp}.md`, committed: true, sha: 'test-sha' };
    }) as ExecuteDeps['writeReport'],
    callOps: callOpsStub as unknown as ExecuteDeps['callOps'],
  };

  return { deps, captured, writes };
}

const rowOf = async (runId: string) =>
  (await getDb().select().from(schema.scheduleRuns)
    .where(eq(schema.scheduleRuns.id, runId)))[0]!;

const scheduleRow = async (scheduleId: string) =>
  (await getDb().select().from(schema.schedules)
    .where(eq(schema.schedules.id, scheduleId)))[0]!;

const alertKinds = async (scheduleId: string) =>
  (await getDb().select({ kind: schema.scheduleAlerts.kind }).from(schema.scheduleAlerts)
    .where(eq(schema.scheduleAlerts.scheduleId, scheduleId))).map((r) => r.kind);

const heldCount = async () =>
  (await getDb().select({ id: schema.heldNotifications.id }).from(schema.heldNotifications)
    .where(eq(schema.heldNotifications.organizationId, ORG))).length;

const OK_SYNC: StepResponse = {
  exitCode: 0,
  json: { schema_version: 1, sync_status: 'ok', added: 2, modified: 1, deleted: 0 },
  stdout: 'Synced 3 files\n',
};

describe('executing a claimed run', () => {
  test('a successful source-scoped run writes a report and marks the run succeeded', async () => {
    const scheduleId = await schedule();
    const claimed = await occurrence(scheduleId, { slot: 's-ok', fireAtMs: QUIET_MS, nowMs: QUIET_MS });
    const { deps, writes } = harness(() => OK_SYNC, QUIET_MS);

    const result = await executeRun(claimed, deps);

    const row = await rowOf(claimed.run.id);
    expect(result.classification).toBe('ok');
    expect(row.state).toBe('succeeded');
    expect(row.classification).toBe('ok');
    expect(row.exitCode).toBe(0);
    expect(result.reportPath).toBe(row.reportPath);
    expect(writes.length).toBe(1);
    expect(writes[0]!.sourceId).toBe(SOURCE_ID);
    expect(writes[0]!.actor.email).toBe(`exec-${USER}@test.local`);
    // The stamp is the ORG-LOCAL wall clock of the slot, not UTC: 03:00 EDT.
    expect(writes[0]!.stamp).toBe('2026-09-15-0300');
    expect(writes[0]!.reportBody).toContain('# exec-');
    expect(writes[0]!.reportBody).toContain('Result: `ok`');
  });

  test('the --source flag comes from the Connection, never from schedule.params', async () => {
    const scheduleId = await schedule({ params: {} });
    const claimed = await occurrence(scheduleId, { slot: 's-source', fireAtMs: QUIET_MS, nowMs: QUIET_MS });
    const { deps, captured } = harness(() => OK_SYNC, QUIET_MS);

    await executeRun(claimed, deps);

    // Not `other` (the org's other Space), not absent, not from the stored params.
    expect(captured.length).toBe(1);
    expect(captured[0]!.op).toBe('sync');
    expect(captured[0]!.params).toEqual({ source: SOURCE_ID, noPull: true, noEmbed: true });
    expect((await scheduleRow(scheduleId)).params).toEqual({});
  });

  test('a revoked Connection refuses the run rather than falling back to ops admin', async () => {
    const revoked = await connection({ state: 'revoked' });
    const scheduleId = await schedule({ connectionId: revoked });
    const claimed = await occurrence(scheduleId, { slot: 's-revoked', fireAtMs: QUIET_MS, nowMs: QUIET_MS });
    const { deps, captured, writes } = harness(() => OK_SYNC, QUIET_MS);

    const result = await executeRun(claimed, deps);

    expect(result.classification).toBe('refused');
    expect(captured.length).toBe(0);
    expect(writes.length).toBe(0);
    expect(result.reportPath).toBeNull();
    expect((await rowOf(claimed.run.id)).state).toBe('failed');
    expect(await alertKinds(scheduleId)).toContain('run_refused');
  });

  test('report_policy on_change_or_failure skips a zero-change success', async () => {
    const scheduleId = await schedule({ reportPolicy: 'on_change_or_failure' });
    const claimed = await occurrence(scheduleId, { slot: 's-nochange', fireAtMs: QUIET_MS, nowMs: QUIET_MS });
    const { deps, writes } = harness(() => ({
      exitCode: 0,
      json: { sync_status: 'ok', added: 0, modified: 0, deleted: 0 },
    }), QUIET_MS);

    const result = await executeRun(claimed, deps);

    expect(result.classification).toBe('ok');
    expect(writes.length).toBe(0);
    expect(result.reportPath).toBeNull();
    expect((await rowOf(claimed.run.id)).reportPath).toBeNull();
    expect((await rowOf(claimed.run.id)).state).toBe('succeeded');
  });

  test('an UNREADABLE payload still writes a report — unknown is not "no change"', async () => {
    const scheduleId = await schedule({ reportPolicy: 'on_change_or_failure' });
    const claimed = await occurrence(scheduleId, { slot: 's-null-json', fireAtMs: QUIET_MS, nowMs: QUIET_MS });
    const { deps, writes } = harness(() => ({ exitCode: 0, json: null }), QUIET_MS);

    const result = await executeRun(claimed, deps);

    expect(result.classification).toBe('ok');
    expect(writes.length).toBe(1);
    expect((await rowOf(claimed.run.id)).summary).toEqual({ changed: null, status: null });
  });

  test('a push rejection raises push_rejected and is never swallowed', async () => {
    const scheduleId = await schedule({ operation: 'sources-push' });
    const claimed = await occurrence(scheduleId, { slot: 's-push', fireAtMs: QUIET_MS, nowMs: QUIET_MS });
    const { deps, captured } = harness(() => ({
      exitCode: 1,
      json: { ok: false, status: 'push_failed', reason: 'non-fast-forward' },
      stderr: 'error: failed to push some refs\n',
    }), QUIET_MS);

    const result = await executeRun(claimed, deps);

    expect(result.classification).toBe('conflict');
    expect(captured[0]!.params).toEqual({ id: SOURCE_ID });
    expect(await alertKinds(scheduleId)).toContain('push_rejected');
    expect((await rowOf(claimed.run.id)).state).toBe('failed');
  });

  test('a notifying job inside quiet hours is HELD, and its report is still written', async () => {
    const scheduleId = await schedule({ notifies: true });
    const claimed = await occurrence(scheduleId, { slot: 's-quiet', fireAtMs: QUIET_MS, nowMs: QUIET_MS });
    const { deps, writes } = harness(() => OK_SYNC, QUIET_MS);

    const result = await executeRun(claimed, deps);

    expect((await rowOf(claimed.run.id)).state).toBe('held');
    expect((await rowOf(claimed.run.id)).reportPath).not.toBeNull();
    expect(writes.length).toBe(1);
    expect(await heldCount()).toBe(1);
    const [held] = await getDb().select().from(schema.heldNotifications)
      .where(eq(schema.heldNotifications.organizationId, ORG));
    expect(held!.headline).toBe(`${(await scheduleRow(scheduleId)).name} — ok`);
    expect(held!.reportPath).toBe(result.reportPath);
    expect(held!.releasedAt).toBeNull();
  });

  test('a notifying job outside quiet hours is not held', async () => {
    const scheduleId = await schedule({ notifies: true });
    const claimed = await occurrence(scheduleId, { slot: 's-awake', fireAtMs: AWAKE_MS, nowMs: AWAKE_MS });
    const { deps } = harness(() => OK_SYNC, AWAKE_MS);

    await executeRun(claimed, deps);

    expect((await rowOf(claimed.run.id)).state).toBe('succeeded');
    expect(await heldCount()).toBe(0);
  });

  test('the persisted summary carries counts and status only — never stdout or argv', async () => {
    const scheduleId = await schedule();
    const claimed = await occurrence(scheduleId, { slot: 's-summary', fireAtMs: QUIET_MS, nowMs: QUIET_MS });
    const { deps, writes } = harness(() => ({
      exitCode: 0,
      json: { sync_status: 'ok', added: 3, modified: 1, deleted: 0, token: 'sk-livekeyvalue1234' },
      stdout: 'Synced 4 files with sk-livekeyvalue1234\n',
    }), QUIET_MS);

    await executeRun(claimed, deps);

    const summary = (await rowOf(claimed.run.id)).summary as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual(['changed', 'status']);
    expect(summary).toEqual({ changed: 4, status: 'ok' });
    expect(JSON.stringify(summary)).not.toContain('sk-');
    // And the report that IS allowed to carry prose scrubs the credential out.
    expect(writes[0]!.reportBody).not.toContain('sk-livekeyvalue1234');
    expect(writes[0]!.reportBody).toContain('***REDACTED***');
  });

  const AUTOPILOT = (installed: boolean, state: string) => ({
    installed, install_target: installed ? 'ephemeral-container' : null, state,
    disabled_reason: null, paused_reason: null, heartbeat_age_seconds: installed ? 12 : null,
    stale_after_seconds: 1800, last_log: '',
  });

  test('the autopilot tripwire is silent when nothing is installed', async () => {
    const scheduleId = await schedule({
      operation: 'autopilot-status', preset: 'autopilot-tripwire', reportPolicy: 'on_change_or_failure',
    });
    const claimed = await occurrence(scheduleId, { slot: 's-ap-ok', fireAtMs: AWAKE_MS, nowMs: AWAKE_MS });
    const { deps, captured, writes } = harness(() => ({ exitCode: 0, json: AUTOPILOT(false, 'not_installed') }), AWAKE_MS);

    const result = await executeRun(claimed, deps);

    expect(result.classification).toBe('ok');
    expect(captured[0]!.op).toBe('autopilot.status');
    expect(captured[0]!.params).toEqual({});          // brain-wide: no fence injected
    expect(writes.length).toBe(0);                    // changeCount 0 -> no report
    expect(await alertKinds(scheduleId)).toEqual([]);
    expect((await rowOf(claimed.run.id)).state).toBe('succeeded');
  });

  test('a FRESH autopilot install trips the wire even though gbrain exited 0', async () => {
    const scheduleId = await schedule({
      operation: 'autopilot-status', preset: 'autopilot-tripwire', reportPolicy: 'on_change_or_failure',
    });
    const claimed = await occurrence(scheduleId, { slot: 's-ap-fresh', fireAtMs: AWAKE_MS, nowMs: AWAKE_MS });
    const { deps, writes } = harness(() => ({ exitCode: 0, json: AUTOPILOT(true, 'fresh') }), AWAKE_MS);

    const result = await executeRun(claimed, deps);

    expect(result.classification).toBe('conflict');
    expect(writes.length).toBe(1);
    expect(await alertKinds(scheduleId)).toEqual(['autopilot_installed']);
    expect((await rowOf(claimed.run.id)).state).toBe('failed');
  });

  test('an unreadable autopilot probe is a failure with a report, never a pass', async () => {
    const scheduleId = await schedule({
      operation: 'autopilot-status', preset: 'autopilot-tripwire', reportPolicy: 'on_change_or_failure',
    });
    const claimed = await occurrence(scheduleId, { slot: 's-ap-junk', fireAtMs: AWAKE_MS, nowMs: AWAKE_MS });
    const { deps, writes } = harness(() => ({
      exitCode: 2, stderr: "Unknown autopilot argument 'x'.\n",
    }), AWAKE_MS);

    const result = await executeRun(claimed, deps);

    expect(result.classification).toBe('failed');
    expect(writes.length).toBe(1);
    expect(await alertKinds(scheduleId)).toEqual(['run_failed']);
  });
});

describe('live-sync two-step', () => {
  test('live-sync runs sync then embed --stale under one run row', async () => {
    const scheduleId = await schedule({ preset: 'live-sync', params: {} });
    const claimed = await occurrence(scheduleId, { slot: 's-live', fireAtMs: QUIET_MS, nowMs: QUIET_MS });
    const { deps, captured, writes } = harness((op) => (op === 'sync' ? OK_SYNC : {
      exitCode: 0,
      json: { embedded: 4, skipped: 0, total_chunks: 12 },
      stdout: 'Embedded 4 chunks\n',
    }), QUIET_MS);

    const result = await executeRun(claimed, deps);

    expect(captured.map((c) => c.op)).toEqual(['sync', 'embed']);
    // The fence is re-applied to step 2: `stale` is ours, `source` the Connection's.
    expect(captured[1]!.params).toEqual({ stale: true, maxUsd: '1', source: 'shared' });
    expect(result.classification).toBe('ok');
    // One run row, one report.
    expect(writes.length).toBe(1);
    const rows = await getDb().select({ id: schema.scheduleRuns.id }).from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.scheduleId, scheduleId));
    expect(rows.length).toBe(1);
    // The combined report names BOTH commands and keeps both streams.
    expect(writes[0]!.reportBody).toContain('gbrain sync --source shared --no-pull --no-embed --json');
    expect(writes[0]!.reportBody).toContain('gbrain embed --stale --source shared --max-usd 1 --json');
    expect(writes[0]!.reportBody).toContain('Embedded 4 chunks');
    expect((await rowOf(claimed.run.id)).state).toBe('succeeded');
    expect((await rowOf(claimed.run.id)).summary).toEqual({ changed: 7, status: 'ok' });
  });

  test('a failing sync does NOT proceed to embed', async () => {
    const scheduleId = await schedule({ preset: 'live-sync', params: {} });
    const claimed = await occurrence(scheduleId, { slot: 's-live-fail', fireAtMs: QUIET_MS, nowMs: QUIET_MS });
    const { deps, captured } = harness(() => ({
      exitCode: 1, json: { sync_status: 'error' }, stderr: 'fatal: bad revision\n',
    }), QUIET_MS);

    const result = await executeRun(claimed, deps);

    expect(captured.map((c) => c.op)).toEqual(['sync']);
    expect(result.classification).toBe('failed');
    expect((await rowOf(claimed.run.id)).state).toBe('failed');
  });

  test('a run kill_previous cancelled mid-flight is cancelled, not a timeout', async () => {
    const scheduleId = await schedule({ preset: 'live-sync', params: {} });
    const claimed = await occurrence(scheduleId, { slot: 's-killed', fireAtMs: QUIET_MS, nowMs: QUIET_MS });
    // The overlap policy marks the victim the moment it takes the slot — while
    // our child is still running. The child then dies on SIGTERM (exit 143).
    const { deps, writes } = harness(async () => {
      await getDb().update(schema.scheduleRuns)
        .set({ cancelRequested: true, state: 'cancelled', classification: 'cancelled' })
        .where(eq(schema.scheduleRuns.id, claimed.run.id));
      return { exitCode: 143, json: null, stderr: 'Terminated\n' };
    }, QUIET_MS);

    const result = await executeRun(claimed, deps);

    expect(result.classification).toBe('cancelled');
    const row = await rowOf(claimed.run.id);
    expect(row.state).toBe('cancelled');
    expect(row.classification).toBe('cancelled');
    expect(row.exitCode).toBe(143);
    // A run an operator chose to end is not a failure, so it raises no alert.
    expect(await alertKinds(scheduleId)).toEqual([]);
    expect(writes[0]!.reportBody).toContain('Result: `cancelled`');
  });

  test('the combined classification is the WORSE of the two steps', async () => {
    const scheduleId = await schedule({ preset: 'live-sync', params: {} });
    const claimed = await occurrence(scheduleId, { slot: 's-live-worse', fireAtMs: QUIET_MS, nowMs: QUIET_MS });
    const { deps, captured, writes } = harness((op) => (op === 'sync' ? OK_SYNC : {
      exitCode: 1, json: { status: 'embed_failed' }, stderr: 'provider unavailable\n',
    }), QUIET_MS);

    const result = await executeRun(claimed, deps);

    expect(captured.map((c) => c.op)).toEqual(['sync', 'embed']);
    expect(result.classification).toBe('failed');
    const row = await rowOf(claimed.run.id);
    expect(row.classification).toBe('failed');
    expect(row.exitCode).toBe(1);
    expect(row.state).toBe('failed');
    expect(await alertKinds(scheduleId)).toContain('run_failed');
    // The failing step's stderr is what the operator needs; it is not dropped
    // in favour of the step that succeeded.
    expect(writes[0]!.reportBody).toContain('provider unavailable');
    expect(writes[0]!.reportBody).toContain('## Steps');
  });
});
