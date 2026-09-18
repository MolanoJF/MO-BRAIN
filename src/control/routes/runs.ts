/**
 * `/api/runs/*` — the runner's whole interface, and the two human routes that
 * read what it recorded (Task 6, D1, D3, D11).
 *
 * Two credential systems meet here and are never conflated:
 *
 *   * the RUNNER bearer, constant-time compared exactly like `OPS_RPC_TOKEN` in
 *     `src/ops/server.ts`. **An empty `RUNNER_TOKEN` never authenticates** — two
 *     empty strings pass `timingSafeEqual`, so the guard runs FIRST and answers
 *     `503 runner_disabled` before any comparison. Compose interpolates
 *     `${RUNNER_TOKEN:-}` on both sides (D12), which is precisely why the runtime
 *     owns the refusal: a runner-less deployment must not fail to boot, it must
 *     fail to authenticate.
 *   * a Better Auth session for the projection and revert routes, through the
 *     `guard()` idiom from `src/control/routes/upgrades.ts`.
 *
 * Neither route is ever routed publicly (D6): Caddy gains no route for
 * `/api/runs`, and the runner reaches them directly on `runner-net`.
 */
import { Hono, type Context } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { getDb, schema } from '../db/client.ts';
import { requireRole, type Role } from '../rbac.ts';
import { recordRunnerSeen, runnerTokenConfigured } from '../../agent/runners.ts';
import {
  RUN_CLAIM_WAIT_MS, claimAgentRun, finishAgentRun, heartbeatAgentRun, recordEvents,
} from '../../agent/claim.ts';
import { revertRun } from '../../agent/revert.ts';
import type { AgentRunEvent } from '../../agent/types.ts';

export const runRoutes = new Hono();

/** D3's long-poll ceiling, read per call so a test (or a tight proxy) can lower
 *  it without a rebuild. The default lives in `agent/claim.ts`, named once. */
function claimWaitMs(): number {
  const configured = Number(process.env.RUN_CLAIM_WAIT_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : RUN_CLAIM_WAIT_MS;
}

/** D3: poll on a short interval rather than a busy loop. */
function claimPollMs(): number {
  const configured = Number(process.env.RUN_CLAIM_POLL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 2_000;
}

/**
 * Constant-time compare, and the empty-token refusal happens before it is ever
 * reached — `runnerTokenConfigured()` is the one definition of "the lane is on"
 * (honesty rule 8), and whitespace is not a credential.
 */
function runnerAuthorized(c: { req: { header: (n: string) => string | undefined } }): boolean {
  const expected = (process.env.RUNNER_TOKEN ?? '').trim();
  if (!expected) return false;
  const header = c.req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One error shape for both wrappers. Narrowed here so no call site needs a cast:
 * `requireRole` throws a `Response` (the 401/403), Hono's own errors carry a
 * status, and anything else is a 400 like the upgrades routes assume.
 */
function errorResponse(e: unknown, fallback: string): Response {
  if (e instanceof Response) return e;
  const status = e && typeof e === 'object' && 'status' in e && typeof e.status === 'number'
    ? e.status
    : 400;
  const message = e instanceof Error ? e.message : fallback;
  return Response.json({ error: message }, { status });
}

/** The runner guard, in the order that makes the empty case unreachable. */
const runner = (handler: (c: Context) => Promise<Response>) => async (c: Context) => {
  if (!runnerTokenConfigured()) return c.json({ error: 'runner_disabled' }, 503);
  if (!runnerAuthorized(c)) return c.json({ error: 'unauthorized' }, 401);
  try {
    return await handler(c);
  } catch (e) {
    // S3c: the message may name a Space or a run id; it never carries a body.
    return errorResponse(e, 'runner_error');
  }
};

/** The same wrapper the upgrades routes use: a thrown Response is the 401/403. */
const guard = (
  min: Role,
  handler: (c: Context, ctx: { userId: string; orgId: string; role: Role }) => Promise<Response>,
) =>
  async (c: Context) => {
    let ctx: { userId: string; orgId: string; role: Role };
    try { ctx = await requireRole(c, min); } catch (e) { return errorResponse(e, 'unauthorized'); }
    try { return await handler(c, ctx); }
    catch (e) { return errorResponse(e, 'runs_error'); }
  };

/** A body is optional on `/claim` (a runner that sends none fails the runner id
 *  check with a structured refusal, not a parse error). Never logged (S3c). */
async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Hono's untyped `Context` reports a path param as `string | undefined`; the
 * route pattern is what guarantees it is there. An absent one becomes an empty
 * id, which matches no row — an honest not-found rather than a cast.
 */
const runIdParam = (c: Context): string => c.req.param('id') ?? '';

/** 400 for the two request-shape refusals, 409 for the four run refusals. */
function refusalStatus(error: string): 400 | 409 {
  return error === 'runner_never_seen' || error === 'harness_version_required' ? 400 : 409;
}

// --- the runner lane ---------------------------------------------------------

/**
 * D3: long-poll, not busy-poll, and not a socket. The request is held up to
 * `RUN_CLAIM_WAIT_MS` (default 25s, deliberately under the common 30s proxy idle
 * timeout) and answers `204 No Content` on timeout, at which point the runner
 * loops immediately.
 *
 * D2: the request is also the SEEING. `recordRunnerSeen` runs first — before any
 * work is claimed, before the long poll is even entered — so a runner that polls
 * and finds nothing has still announced itself to `runner_presence`, which is what
 * lets `/api/health` and the schedule create gate tell "no runner has ever been
 * seen" apart from "one is knocking right now". Recording it once per REQUEST
 * (not once per claim) is the point: the empty 204 is the common case, and it is
 * exactly the case the old live-lease reading got wrong.
 *
 * A refusal is returned at once rather than polled through: every refusal except
 * the two request-shape ones CONSUMED the occurrence (D11), so staying in the
 * loop would only re-refuse a run that no longer exists.
 */
runRoutes.post('/claim', runner(async (c) => {
  const body = await jsonBody(c);
  const runnerId = typeof body.runnerId === 'string' ? body.runnerId : '';
  const harnessVersion = typeof body.harnessVersion === 'string' ? body.harnessVersion : '';
  await recordRunnerSeen(runnerId, harnessVersion);
  const deadline = Date.now() + claimWaitMs();

  for (;;) {
    const outcome = await claimAgentRun({ runnerId, harnessVersion });
    if (outcome.status === 'claimed') return c.json(outcome.claim);
    if (outcome.status === 'refused') {
      return c.json(outcome.refusal, refusalStatus(outcome.refusal.error));
    }
    if (Date.now() >= deadline) return c.body(null, 204);
    await Bun.sleep(Math.min(claimPollMs(), Math.max(0, deadline - Date.now())));
  }
}));

runRoutes.post('/:id/heartbeat', runner(async (c) => {
  const body = await jsonBody(c);
  const runnerId = typeof body.runnerId === 'string' ? body.runnerId : '';
  const result = await heartbeatAgentRun(runIdParam(c), runnerId, Date.now());
  if ('ok' in result) return c.json(result);
  return c.json(result, result.error === 'run_unknown' ? 404 : 409);
}));

runRoutes.post('/:id/events', runner(async (c) => {
  const body = await jsonBody(c);
  const raw = Array.isArray(body.events) ? body.events : null;
  if (!raw) return c.json({ error: 'invalid_event', detail: 'events must be an array' }, 400);
  const outcome = await recordEvents(runIdParam(c), raw as AgentRunEvent[]);
  if ('error' in outcome) return c.json(outcome, outcome.error === 'run_unknown' ? 404 : 400);
  return c.json(outcome);
}));

runRoutes.post('/:id/finish', runner(async (c) => {
  const body = await jsonBody(c);
  const runnerId = typeof body.runnerId === 'string' ? body.runnerId : '';
  const exitCode = typeof body.exitCode === 'number' && Number.isInteger(body.exitCode)
    ? body.exitCode
    : null;
  if (exitCode === null) {
    return c.json({
      error: 'invalid_exit_code',
      detail: 'exitCode must be an integer; -1 is the runner\'s report that no process produced one',
    }, 400);
  }
  const outcome = await finishAgentRun({
    runId: runIdParam(c),
    runnerId,
    exitCode,
    errorFrames: typeof body.errorFrames === 'number' ? body.errorFrames : undefined,
    numTurns: typeof body.numTurns === 'number' ? body.numTurns : undefined,
  });
  if ('error' in outcome) return c.json(outcome, outcome.error === 'run_unknown' ? 404 : 409);
  return c.json(outcome);
}));

// --- what a human reads ------------------------------------------------------

/**
 * The projection IS the contract (Task 6): prompt, events, usage, diff, cost and
 * attribution in one page load, and **no run token, no gateway token, no raw
 * model request body**. The tokens are not in this projection because they are
 * not in the tables that feed it — `agent_runs` stores a client ID, never a
 * bearer (D8), and the gateway token is stateless (D7). This function is the
 * single place that decides what leaves.
 */
export type RunSummary = {
  runId: string;
  scheduleId: string;
  scheduleName: string | null;
  state: string;
  attempt: number;
  slot: string;
  fireAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  model: string;
  harnessVersion: string;
  budgetUsd: string;
  costUsd: string | null;
  failureClass: string | null;
  numTurns: number;
  revertedAt: Date | null;
  revertCommit: string | null;
};

export function projectRunSummary(row: {
  run: typeof schema.agentRuns.$inferSelect;
  scheduleId: string;
  scheduleName: string | null;
  state: string;
  attempt: number;
  slot: string;
  fireAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}): RunSummary {
  return {
    runId: row.run.runId,
    scheduleId: row.scheduleId,
    scheduleName: row.scheduleName,
    state: row.state,
    attempt: row.attempt,
    slot: row.slot,
    fireAt: row.fireAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    model: row.run.model,
    harnessVersion: row.run.harnessVersion,
    budgetUsd: row.run.budgetUsd,
    costUsd: row.run.costUsd,
    failureClass: row.run.failureClass,
    numTurns: row.run.numTurns,
    revertedAt: row.run.revertedAt,
    revertCommit: row.run.revertCommit,
  };
}

/**
 * The detail projection. `meat` is everything joined in by the caller so this
 * stays a pure shape decision a test can assert without a database.
 */
export function projectRunDetail(input: {
  run: typeof schema.agentRuns.$inferSelect;
  summary: RunSummary;
  prompt: string | null;
  connectionId: string | null;
  clientName: string | null;
  events: Array<{ seq: number; at: Date; kind: string; data: unknown }>;
  usage: Array<{
    seq: number; at: Date; model: string; inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheWriteTokens: number; costUsd: string | null;
    stopReason: string | null; httpStatus: number | null;
  }>;
}) {
  return {
    ...input.summary,
    connectionId: input.connectionId,
    clientName: input.clientName,
    prompt: input.prompt,
    events: input.events,
    usage: input.usage,
    failureDetail: input.run.failureDetail,
    diff: input.run.diffSummary,
    heads: { before: input.run.headsBefore, after: input.run.headsAfter },
    tokenRevokedAt: input.run.tokenRevokedAt,
  };
}

/** The agent lane only: this URL is the run ledger's agent view, and a
 *  `gbrain_command` row has none of the columns it projects. */
runRoutes.get('/', guard('viewer', async (c, ctx) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
  const rows = await getDb().select({
    run: schema.agentRuns,
    scheduleId: schema.scheduleRuns.scheduleId,
    scheduleName: schema.schedules.name,
    state: schema.scheduleRuns.state,
    attempt: schema.scheduleRuns.attempt,
    slot: schema.scheduleRuns.slot,
    fireAt: schema.scheduleRuns.fireAt,
    startedAt: schema.scheduleRuns.startedAt,
    finishedAt: schema.scheduleRuns.finishedAt,
  })
    .from(schema.agentRuns)
    .innerJoin(schema.scheduleRuns, eq(schema.scheduleRuns.id, schema.agentRuns.runId))
    .innerJoin(schema.schedules, eq(schema.schedules.id, schema.scheduleRuns.scheduleId))
    .where(and(
      eq(schema.agentRuns.organizationId, ctx.orgId),
      eq(schema.schedules.jobType, 'agent_prompt'),
    ))
    .orderBy(desc(schema.scheduleRuns.startedAt))
    .limit(limit);

  return c.json({ runs: rows.map(projectRunSummary) });
}));

runRoutes.get('/:id', guard('viewer', async (c, ctx) => {
  const runId = runIdParam(c);
  const db = getDb();
  const [row] = await db.select({
    run: schema.agentRuns,
    scheduleId: schema.scheduleRuns.scheduleId,
    scheduleName: schema.schedules.name,
    prompt: schema.schedules.agentPrompt,
    clientName: schema.connections.clientName,
    state: schema.scheduleRuns.state,
    attempt: schema.scheduleRuns.attempt,
    slot: schema.scheduleRuns.slot,
    fireAt: schema.scheduleRuns.fireAt,
    startedAt: schema.scheduleRuns.startedAt,
    finishedAt: schema.scheduleRuns.finishedAt,
  })
    .from(schema.agentRuns)
    .innerJoin(schema.scheduleRuns, eq(schema.scheduleRuns.id, schema.agentRuns.runId))
    .innerJoin(schema.schedules, eq(schema.schedules.id, schema.scheduleRuns.scheduleId))
    .leftJoin(schema.connections, eq(schema.connections.id, schema.agentRuns.connectionId))
    .where(and(
      eq(schema.agentRuns.runId, runId),
      eq(schema.agentRuns.organizationId, ctx.orgId),
    ));
  if (!row) return c.json({ error: 'run_not_found' }, 404);

  const [events, usage] = await Promise.all([
    db.select({
      seq: schema.agentRunEvents.seq,
      at: schema.agentRunEvents.at,
      kind: schema.agentRunEvents.kind,
      data: schema.agentRunEvents.data,
    }).from(schema.agentRunEvents)
      .where(eq(schema.agentRunEvents.runId, runId))
      .orderBy(schema.agentRunEvents.seq),
    db.select({
      seq: schema.agentRunUsage.seq,
      at: schema.agentRunUsage.at,
      model: schema.agentRunUsage.model,
      inputTokens: schema.agentRunUsage.inputTokens,
      outputTokens: schema.agentRunUsage.outputTokens,
      cacheReadTokens: schema.agentRunUsage.cacheReadTokens,
      cacheWriteTokens: schema.agentRunUsage.cacheWriteTokens,
      costUsd: schema.agentRunUsage.costUsd,
      stopReason: schema.agentRunUsage.stopReason,
      httpStatus: schema.agentRunUsage.httpStatus,
    }).from(schema.agentRunUsage)
      .where(eq(schema.agentRunUsage.runId, runId))
      .orderBy(schema.agentRunUsage.seq),
  ]);

  const { prompt, clientName, ...summary } = row;
  return c.json(projectRunDetail({
    run: row.run,
    summary: projectRunSummary(summary),
    prompt,
    connectionId: row.run.connectionId,
    clientName,
    events,
    usage,
  }));
}));

/**
 * D10 — admin only, and the actor is a NAMED human: the audit story is that
 * someone reverted this run, never that "the system" did. `revertRun` owns the
 * three refusal codes and the re-index; this route owns the status mapping and
 * the identity lookup.
 */
runRoutes.post('/:id/revert', guard('admin', async (c, ctx) => {
  const confirm = c.req.query('confirm') === 'concurrent' ? 'concurrent' as const : undefined;
  const outcome = await revertRun({
    runId: runIdParam(c),
    actor: await actorIdentity(ctx.userId),
    confirm,
  });
  if ('error' in outcome) return c.json(outcome, 409);
  return c.json(outcome);
}));

/** The acting admin's identity, from the session's user row — never a body. */
async function actorIdentity(userId: string): Promise<{ name: string; email: string }> {
  const [user] = await getDb().select({ name: schema.users.name, email: schema.users.email })
    .from(schema.users).where(eq(schema.users.id, userId));
  if (!user) throw Object.assign(new Error('actor_unknown'), { status: 401 });
  return { name: user.name ?? user.email, email: user.email };
}
