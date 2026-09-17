/**
 * Task 6 — Dispatch: the agent lane's own claim, heartbeat, event append and
 * finish (D2, D3, D9, D11; honesty rules 1, 5, 8, 9, 10, 11).
 *
 * The runner is a CLIENT of the control plane, never of the database (D1): every
 * function here is reached through `src/control/routes/runs.ts` and every secret
 * leaves through exactly one of them — the claim response (D3).
 *
 * Three things in this file are decisions rather than plumbing:
 *
 * 1. **A refusal is recorded, not thrown** (D11's `refused`). Each precondition
 *    has its own `{ error, …context }` code, and consuming the occurrence is
 *    deliberate: the failure class lives on the row (L14), `refused` is never
 *    retried, and a run left `pending` would be re-refused on every long poll
 *    forever.
 * 2. **The finish path's step (c) commits the run's writes.** Task 1's P8 proved
 *    an MCP `put_page` produces ZERO commits: the file lands untracked and HEAD
 *    does not move, so without `commitAs` every diff would be empty and every
 *    revert a no-op. `commitAs` is our own primitive and passes
 *    `-c user.name -c user.email`, which Space repos have no other source of
 *    (F12).
 * 3. **The cost rollup is computed from `agent_run_usage`, never accumulated.**
 *    Gate C asserts `agent_runs.cost_usd` equals `SUM(agent_run_usage.cost_usd)`,
 *    and that assertion is only worth making if the value is derived that way.
 *    `NULL` stays distinct from `0` (honesty rule 3).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { getDb, schema } from '../control/db/client.ts';
import { GBRAIN_PIN } from '../contracts/pin.ts';
import { latestSnapshotFor } from '../upgrade/capability.ts';
import { mcpUrl } from '../control/connections.ts';
import { callOps, commitAsMember, deleteCredentialJournal, gitRange } from '../control/opsClient.ts';
import { mintGatewayToken } from '../gateway/token.ts';
import { claimNextRun, finishRun, heartbeat } from '../scheduler/claim.ts';
import { AGENT_ALERT_KINDS, raiseAgentAlert, type AgentAlertKind } from './alerts.ts';
import { classifyAgentExit, retryPolicyFor } from './classify.ts';
import { captureHeads, diffForRun } from './diff.ts';
import { mintRunToken, revokeRunToken } from './token.ts';
import { allowedToolsFor } from './tools.ts';
import type {
  AgentRunClaim, AgentRunEvent, AgentRunSpec, DiffSummary, FailureClass, SpaceHeads,
} from './types.ts';

type RunRow = typeof schema.scheduleRuns.$inferSelect;
type ScheduleRow = typeof schema.schedules.$inferSelect;
type ConnectionRow = typeof schema.connections.$inferSelect;

/**
 * D8/D7: both per-run tokens outlive the run's own deadline by this much, so a
 * run that finishes at the last second is not revoked mid-flight — and neither
 * token ever outlives a run that was actually reaped. Defence in depth; the
 * mechanism is revocation.
 */
const RUN_TOKEN_MARGIN_S = 300;

/** D3: the long poll's ceiling, and the default the route reads env over. */
export const RUN_CLAIM_WAIT_MS = 25_000;

/**
 * D6: the runner addresses the control plane DIRECTLY on `runner-net` — only
 * `/mcp` goes through Caddy, and only so `X-Forwarded-For` stays Caddy's job.
 * Compose gives the runner `CONTROL_URL`; this is the control plane's own view
 * of the same address, so the claim can hand back a URL the caller can dial.
 */
export function controlUrlForRunner(): string {
  const configured = process.env.RUNNER_CONTROL_URL
    ?? `http://control-plane:${process.env.PORT ?? 3150}`;
  return configured.replace(/\/+$/, '');
}

/**
 * D3/D6: the `/mcp` URL the runner is TOLD to dial, which is not always the
 * public one. The runner reaches gbrain only through Caddy, over `runner-net`,
 * where the public origin may not be dialable at all: with DOMAIN=localhost,
 * /etc/hosts inside the runner maps `localhost` to its OWN loopback and wins
 * over Docker's embedded resolver, so `https://localhost/mcp` — which
 * `PUBLIC_URL` builds — hits the runner itself. Compose therefore hands the
 * dev stack an internal name (`RUNNER_MCP_ORIGIN`, see
 * compose/docker-compose.dev.yml) that Docker's resolver answers and Caddy
 * serves from its local CA.
 *
 * Unset (or empty) it is exactly `mcpUrl()` — the same `PUBLIC_URL` the rest of
 * the control plane already defaults to, so production is unchanged. The
 * GRANT's recorded URL stays the public one in every case: the run bearer is a
 * bearer, not host-bound (see `mcpUrl()` in `../control/connections.ts`).
 */
function runnerMcpUrl(): string {
  const origin = process.env.RUNNER_MCP_ORIGIN;
  if (!origin) return mcpUrl();
  const base = origin.replace(/\/+$/, '');
  return base.endsWith('/mcp') ? base : `${base}/mcp`;
}

// --- refusals ----------------------------------------------------------------

/**
 * Every way a claim is refused, one code each. The first two are REQUEST
 * refusals: they are caught before a run exists, so no occurrence is consumed
 * and no retry row is created — a caller bug must not cost a scheduled run.
 *
 * `connection_inactive` / `connection_broken` / `write_space_busy` /
 * `harness_pin_mismatch` are RUN refusals: the occurrence was claimed and is then
 * consumed as D11's `refused`, because a run left `pending` behind a
 * precondition that cannot change would be re-refused on every poll forever.
 *
 * The last three are infrastructure failures in the claim path itself (mint,
 * row, heads) — `infra_failed`, which D11 retries, because none of them is the
 * agent's fault and a retry can genuinely succeed.
 */
export type AgentClaimRefusalCode =
  | 'runner_never_seen'
  | 'harness_version_required'
  | 'connection_inactive'
  | 'connection_broken'
  | 'write_space_busy'
  | 'harness_pin_mismatch'
  | 'run_token_unavailable'
  | 'run_record_failed'
  | 'heads_capture_failed';

export type AgentClaimRefusal = {
  error: AgentClaimRefusalCode;
  /** null when the refusal happened before the run was claimed. */
  runId: string | null;
  scheduleId: string | null;
  detail: string;
  connectionId?: string | null;
  connectionState?: string | null;
  /** D9's single-flight: the agent run that already holds this write Space. */
  holder?: {
    runId: string;
    scheduleId: string;
    claimedBy: string | null;
    leaseExpiresAt: string | null;
  };
  expectedHarnessVersion?: string | null;
  runnerHarnessVersion?: string;
};

export type AgentClaimOutcome =
  | { status: 'claimed'; claim: AgentRunClaim }
  | { status: 'none' }
  | { status: 'refused'; refusal: AgentClaimRefusal };

// --- the claim ---------------------------------------------------------------

/**
 * Claim one `agent_prompt` occurrence and build the response D3 specifies.
 *
 * The order of the success path is load-bearing:
 *
 *   mint the run token → insert the `agent_runs` row (with `gbrain_client_id`)
 *   → capture the pre-run heads → return the claim.
 *
 * The plan's prose put the insert last. It cannot be: a mint that succeeds
 * followed by a failing heads capture would leave a LIVE gbrain client with
 * `agent_runs.gbrain_client_id` unrecorded, and `revokeRunToken` claims a row —
 * so nobody, including the reclaimer, could ever kill it (honesty rule 9). The
 * row is therefore inserted first, and every failure after the mint revokes
 * through it.
 */
export async function claimAgentRun(
  args: { runnerId: string; harnessVersion: string; nowMs?: number },
): Promise<AgentClaimOutcome> {
  const db = getDb();
  const nowMs = args.nowMs ?? Date.now();

  // A claim that does not name its runner is not a claim (D1: `RUNNER_ID` is
  // what lands in `schedule_runs.claimed_by`). "A runner has been seen" can only
  // mean this request, because the control plane cannot read a compose profile —
  // the deployment-level version of the check is `runnerStatus()` (honesty rule
  // 8) and Task 12's create gate, which refuses an agent schedule with no
  // connected runner at all.
  const runnerId = args.runnerId.trim();
  if (!runnerId) {
    return {
      status: 'refused',
      refusal: {
        error: 'runner_never_seen',
        runId: null,
        scheduleId: null,
        detail: 'the claim carried no runner id, so no run was claimed and none was consumed',
      },
    };
  }
  const harnessVersion = args.harnessVersion.trim();
  if (!harnessVersion) {
    // D4: the pin is checked against what the runner's own `claude --version`
    // reports. Without it there is nothing to check, and running an unknown
    // binary is exactly what the pin exists to prevent.
    return {
      status: 'refused',
      refusal: {
        error: 'harness_version_required',
        runId: null,
        scheduleId: null,
        detail: 'the claim did not report the harness version it would run',
      },
    };
  }

  const claimed = await claimNextRun(runnerId, nowMs, { jobTypes: ['agent_prompt'] });
  if (claimed === 'none') return { status: 'none' };
  const { run, schedule } = claimed;

  const context = await loadAgentContext(schedule, run);
  if ('refusal' in context) {
    return refuseRun({
      run, schedule, nowMs,
      failureClass: context.failureClass,
      reason: context.refusal.error,
      detail: context.refusal.detail,
      connectionId: context.refusal.connectionId ?? null,
      alertKind: AGENT_ALERT_KINDS.runFailed,
      alertScheduleId: schedule.id,
      refusal: context.refusal,
    });
  }
  const { connection, member, writeSpace, readSpaces } = context;

  // D9's single-flight, checked at claim time so OUR concurrency is removed from
  // the git range. Residual, stated rather than hidden: two claims racing inside
  // the same millisecond could both pass, because the runner is a client of this
  // API and nothing here holds a lock across the mint. That race is caught rather
  // than hidden — `diffForRun` reports a foreign author as `concurrentWriters`
  // instead of presenting their commits as this run's work (honesty rule 6).
  const holder = await findWriteSpaceHolder(connection, run.id, nowMs);
  if (holder) {
    return refuseRun({
      run, schedule, failureClass: 'refused', nowMs,
      reason: 'write_space_busy',
      detail: `agent run ${holder.id} already holds write Space ${writeSpace.sourceId}`,
      connectionId: connection.id,
      alertKind: AGENT_ALERT_KINDS.runFailed,
      alertScheduleId: schedule.id,
      refusal: {
        error: 'write_space_busy',
        runId: run.id,
        scheduleId: schedule.id,
        connectionId: connection.id,
        detail: `another agent run holds write Space ${writeSpace.sourceId}: single-flight per write `
          + 'Space is what keeps our own writers out of this run\'s git range (D9)',
        holder: {
          runId: holder.id,
          scheduleId: holder.scheduleId,
          claimedBy: holder.claimedBy,
          leaseExpiresAt: holder.leaseExpiresAt?.toISOString() ?? null,
        },
      },
    });
  }

  // D4's runtime cross-check. A mismatch is a REFUSAL, not a silent downgrade:
  // the schedule was written against one build and this runner would run another.
  if (schedule.agentHarnessVersion !== harnessVersion) {
    return refuseRun({
      run, schedule, failureClass: 'refused', nowMs,
      reason: 'harness_pin_mismatch',
      detail: `schedule pins ${schedule.agentHarnessVersion ?? 'none'}, runner reports ${harnessVersion}`,
      connectionId: connection.id,
      // Org-level on purpose (alerts.ts): the mismatch is between two
      // deployments' pins, not between this schedule and one occurrence of it.
      alertKind: AGENT_ALERT_KINDS.harnessPinMismatch,
      alertScheduleId: null,
      refusal: {
        error: 'harness_pin_mismatch',
        runId: run.id,
        scheduleId: schedule.id,
        detail: `schedule ${schedule.id} pins harness ${schedule.agentHarnessVersion ?? 'none'} but the `
          + `claiming runner reports ${harnessVersion}: the run was refused rather than run on an `
          + 'unknown binary',
        expectedHarnessVersion: schedule.agentHarnessVersion,
        runnerHarnessVersion: harnessVersion,
      },
    });
  }

  const spec = specOf(schedule, run, connection, member, writeSpace.sourceId, readSpaces);
  const ttlSeconds = spec.timeoutSeconds + RUN_TOKEN_MARGIN_S;
  const sources = [writeSpace.sourceId, ...spec.readSpaces];

  // (a) the run's gbrain credential. `mintRunToken` self-cleans its own partial
  // failures; nothing here re-does that.
  let token: { gbrainClientId: string; accessToken: string };
  try {
    token = await mintRunToken(connection.id, ttlSeconds);
  } catch (e) {
    return refuseRun({
      run, schedule, failureClass: 'infra_failed', nowMs,
      reason: 'mint_failed',
      detail: message(e),
      connectionId: connection.id,
      alertKind: AGENT_ALERT_KINDS.runFailed,
      alertScheduleId: schedule.id,
      refusal: {
        error: 'run_token_unavailable',
        runId: run.id, scheduleId: schedule.id, connectionId: connection.id,
        detail: `the run token could not be minted: ${message(e)}`,
      },
    });
  }

  // (b) the row, so the client above is revocable from here on.
  try {
    await db.insert(schema.agentRuns).values({
      runId: run.id,
      organizationId: schedule.organizationId,
      connectionId: connection.id,
      model: spec.model,
      harnessVersion: spec.harnessVersion,
      budgetUsd: spec.budgetUsd,
      // NULL, deliberately: no metered call has happened yet, and 0 would claim
      // the run has cost nothing when it has cost nothing YET (honesty rule 3).
      costUsd: null,
      gbrainClientId: token.gbrainClientId,
    });
  } catch (e) {
    // The one window with no row to claim: kill the client we just minted
    // rather than leave a live credential nobody can revoke. Mirrors
    // `killRunClient` in `./token.ts`, which is private and needs a row.
    await killOrphanClient(token.gbrainClientId);
    return refuseRun({
      run, schedule, failureClass: 'infra_failed', nowMs,
      reason: 'agent_run_insert_failed',
      detail: message(e),
      connectionId: connection.id,
      alertKind: AGENT_ALERT_KINDS.runFailed,
      alertScheduleId: schedule.id,
      refusal: {
        error: 'run_record_failed',
        runId: run.id, scheduleId: schedule.id, connectionId: connection.id,
        detail: `the run row could not be written (${message(e)}); its gbrain client was revoked`,
      },
    });
  }

  // (c) D9's "before" heads: the write Space plus every read Space.
  let headsBefore: SpaceHeads;
  try {
    headsBefore = await captureHeads(sources);
    await db.update(schema.agentRuns)
      .set({ headsBefore })
      .where(eq(schema.agentRuns.runId, run.id));
  } catch (e) {
    await revokeRunToken(run.id).catch(() => { /* infra failure: the TTL and the
      reclaimer's retry are the backstops, and the refusal below is the signal. */ });
    return refuseRun({
      run, schedule, failureClass: 'infra_failed', nowMs,
      reason: 'heads_capture_failed',
      detail: message(e),
      connectionId: connection.id,
      alertKind: AGENT_ALERT_KINDS.runFailed,
      alertScheduleId: schedule.id,
      refusal: {
        error: 'heads_capture_failed',
        runId: run.id, scheduleId: schedule.id, connectionId: connection.id,
        detail: `the pre-run heads could not be captured (${message(e)}); the run token was revoked`,
      },
    });
  }

  // (d) the closed tool surface: the product allowlist intersected with the pin's
  // catalog (D5, F11).
  const snapshot = await latestSnapshotFor(db, GBRAIN_PIN).catch(() => null);
  const allowedTools = allowedToolsFor(connection, snapshot);

  // `claimNextRun` sets the lease in the same statement that took the row, so a
  // missing one means that UPDATE did not land — and a claim with no lease is a
  // run the reclaimer cannot honestly own. Absence of evidence is never a pass.
  if (!run.leaseExpiresAt) {
    await revokeRunToken(run.id).catch(() => {});
    return refuseRun({
      run, schedule, failureClass: 'infra_failed', nowMs,
      reason: 'claim_row_incomplete',
      detail: 'the claimed row carries no lease expiry',
      connectionId: connection.id,
      alertKind: AGENT_ALERT_KINDS.runFailed,
      alertScheduleId: schedule.id,
      refusal: {
        error: 'run_record_failed',
        runId: run.id, scheduleId: schedule.id, connectionId: connection.id,
        detail: 'the claimed row carries no lease expiry, so the run cannot be handed out',
      },
    });
  }

  return {
    status: 'claimed',
    claim: {
      runId: run.id,
      scheduleId: schedule.id,
      attempt: run.attempt,
      prompt: spec.prompt,
      model: spec.model,
      maxTokens: spec.maxTokens,
      harnessVersion: spec.harnessVersion,
      allowedTools,
      mcp: { url: runnerMcpUrl(), token: token.accessToken },
      gateway: { url: `${controlUrlForRunner()}/api/gateway`, token: mintGatewayToken(run.id, ttlSeconds) },
      budgetUsd: Number(spec.budgetUsd),
      timeoutSeconds: spec.timeoutSeconds,
      leaseExpiresAt: run.leaseExpiresAt.toISOString(),
    },
  };
}

// --- heartbeat ---------------------------------------------------------------

export type AgentHeartbeatResult =
  | { ok: true; runId: string; leaseExpiresAt: string }
  | {
    error: 'run_unknown' | 'lease_lost' | 'cancel_requested';
    runId: string;
    detail: string;
    state?: string;
    claimedBy?: string | null;
  };

/**
 * Wraps the scheduler's `heartbeat()` — one lease implementation, not two (D2).
 * The 409s are the two ways a live run ends without the runner deciding: the
 * lease was stolen (another runner claimed it, or the reclaimer took it), or
 * `kill_previous` cancelled it. A runner that keeps working through either is
 * double-writing to a Space nobody is watching.
 *
 * Cancellation is checked FIRST, and deliberately so: a cancelled run's lease is
 * not renewed, because renewing it would keep a run alive that the operator has
 * already ended.
 */
export async function heartbeatAgentRun(
  runId: string,
  runnerId: string,
  nowMs: number = Date.now(),
): Promise<AgentHeartbeatResult> {
  const db = getDb();
  const [row] = await db.select({
    state: schema.scheduleRuns.state,
    claimedBy: schema.scheduleRuns.claimedBy,
    cancelRequested: schema.scheduleRuns.cancelRequested,
    leaseExpiresAt: schema.scheduleRuns.leaseExpiresAt,
  }).from(schema.scheduleRuns).where(eq(schema.scheduleRuns.id, runId));

  if (!row) {
    return { error: 'run_unknown', runId, detail: `no run ${runId}` };
  }
  if (row.cancelRequested) {
    return {
      error: 'cancel_requested', runId, state: row.state, claimedBy: row.claimedBy,
      detail: 'this run was cancelled (kill_previous); stop and finish it',
    };
  }

  const held = await heartbeat(runId, runnerId, nowMs);
  if (held) {
    const [renewed] = await db.select({ leaseExpiresAt: schema.scheduleRuns.leaseExpiresAt })
      .from(schema.scheduleRuns).where(eq(schema.scheduleRuns.id, runId));
    if (renewed?.leaseExpiresAt) {
      return { ok: true, runId, leaseExpiresAt: renewed.leaseExpiresAt.toISOString() };
    }
  }
  return {
    error: 'lease_lost', runId, state: row.state, claimedBy: row.claimedBy,
    detail: `the lease is not held by ${runnerId} any more (state ${row.state}, `
      + `claimed by ${row.claimedBy ?? 'nobody'})`,
  };
}

// --- events ------------------------------------------------------------------

export type RecordEventsOutcome =
  | { ok: true; inserted: number; replayed: number }
  | { error: 'run_unknown' | 'invalid_event'; detail: string; index?: number };

/**
 * Append a batch of harness frames. Idempotent on `(run_id, seq)` — the same key
 * `upgrade_events` uses (D2) — because the runner retries a batch after a blip,
 * and a doubled tool call in the audit receipt is a receipt nobody can trust.
 *
 * The UNIQUE index is what does the work; `inserted` counts only the rows that
 * were actually written, so the response can say how much of the batch was a
 * replay rather than claiming credit for it.
 */
export async function recordEvents(
  runId: string,
  events: readonly AgentRunEvent[],
): Promise<RecordEventsOutcome> {
  const db = getDb();
  const [run] = await db.select({ runId: schema.agentRuns.runId })
    .from(schema.agentRuns).where(eq(schema.agentRuns.runId, runId));
  if (!run) return { error: 'run_unknown', detail: `no agent run ${runId}` };

  // Validated here rather than in the route: a frame the ledger cannot order is
  // a caller bug, and `seq` is the only thing that makes the receipt replayable.
  // Keyed by seq, so a seq repeated INSIDE one batch collapses to its last frame
  // (deterministically, and without dropping a neighbour the way a positional
  // pop would).
  const bySeq = new Map<number, { id: string; runId: string; seq: number; kind: string; data: unknown }>();
  for (const [index, event] of events.entries()) {
    if (typeof event?.seq !== 'number' || !Number.isInteger(event.seq) || event.seq < 0) {
      return { error: 'invalid_event', index, detail: 'seq must be a non-negative integer' };
    }
    if (typeof event.kind !== 'string' || event.kind.trim() === '') {
      return { error: 'invalid_event', index, detail: 'kind must be a non-empty string' };
    }
    bySeq.set(event.seq, {
      id: randomUUID(), runId, seq: event.seq, kind: event.kind, data: event.data ?? null,
    });
  }
  const rows = [...bySeq.values()];
  if (rows.length === 0) return { ok: true, inserted: 0, replayed: 0 };

  const inserted = await db.insert(schema.agentRunEvents)
    .values(rows)
    .onConflictDoNothing({ target: [schema.agentRunEvents.runId, schema.agentRunEvents.seq] })
    .returning({ id: schema.agentRunEvents.id });
  return {
    ok: true,
    inserted: inserted.length,
    replayed: rows.length - inserted.length,
  };
}

// --- finish ------------------------------------------------------------------

export type AgentFinishFacts = {
  runId: string;
  /** The claim's claimant. A run belongs to the runner holding its lease. */
  runnerId: string;
  /** The harness's exit code; `-1` is the runner's report that none exists. */
  exitCode: number;
  /** Frames in the recorded stream that reported an error (the runner counts
   *  them; the stream itself is already in `agent_run_events`). */
  errorFrames?: number;
  /** The harness's own turn count, when it reported one. */
  numTurns?: number;
  nowMs?: number;
};

export type AgentFinishResult = {
  runId: string;
  state: string;
  classification: string;
  /** null on a successful run — never a sixth class. */
  failureClass: FailureClass | null;
  failureReason: string | null;
  costUsd: string | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  numTurns: number;
  tokenRevoked: boolean;
  commit: { committed: boolean; sha: string | null } | null;
  diff: DiffSummary | null;
  retry: { runId: string; attempt: number } | null;
};

export type AgentFinishOutcome =
  | { ok: true; result: AgentFinishResult }
  | { error: 'run_unknown' | 'run_not_finished' | 'lease_lost'; runId: string; detail: string; state?: string };

/**
 * Finish a claimed run, in D9's order. Every step is best-effort EXCEPT the row
 * write: a commit that could not land, a diff that could not be read and a
 * token that could not be revoked are all recorded and alerted, because a run we
 * cannot show is not auditable (honesty rule 11) — but the failure class and the
 * cost rollup are what the operator's money depends on.
 */
export async function finishAgentRun(facts: AgentFinishFacts): Promise<AgentFinishOutcome> {
  const db = getDb();
  const nowMs = facts.nowMs ?? Date.now();

  const [row] = await db.select().from(schema.agentRuns)
    .where(eq(schema.agentRuns.runId, facts.runId));
  if (!row) return { error: 'run_unknown', runId: facts.runId, detail: `no agent run ${facts.runId}` };

  const [run] = await db.select().from(schema.scheduleRuns)
    .where(eq(schema.scheduleRuns.id, facts.runId));
  if (!run) return { error: 'run_unknown', runId: facts.runId, detail: `no run ${facts.runId}` };

  // A late finish from a dead runner must not overwrite the reclaimer's verdict
  // (honesty rule 5: a dead runner's run is not a finished run), and a finish
  // from a runner that no longer holds the lease is the same class of claim as a
  // lost heartbeat: 409, not a silent write.
  if (run.state !== 'running') {
    return {
      error: 'run_not_finished', runId: facts.runId, state: run.state,
      detail: `run ${facts.runId} is ${run.state}, not running — another component already decided it`,
    };
  }
  if (run.claimedBy !== facts.runnerId) {
    return {
      error: 'lease_lost', runId: facts.runId, state: run.state,
      detail: `run ${facts.runId} is held by ${run.claimedBy ?? 'nobody'}, not ${facts.runnerId}`,
    };
  }

  const [schedule] = await db.select().from(schema.schedules)
    .where(eq(schema.schedules.id, run.scheduleId));
  if (!schedule) {
    return { error: 'run_unknown', runId: facts.runId, detail: `no schedule ${run.scheduleId}` };
  }
  const context = await loadAgentContext(schedule, run);
  const member = 'refusal' in context ? null : context.member;
  const writeSpace = 'refusal' in context ? null : context.writeSpace.sourceId;
  const readSpaces: string[] = 'refusal' in context
    ? []
    : context.readSpaces.map((s) => s.sourceId);

  // (a) classify. Honesty rule 1: the stream and the exit code are the receipt,
  //     never the agent's own last message. L14: a class a component already
  //     recorded (the meter's `budget_exceeded`, the claim path's `refused`)
  //     wins, because it witnessed the cause and the exit code is only its
  //     symptom. `agent_runs.failure_class` is a text column with a CHECK on the
  //     five classes, so the cast is the column boundary, and a drifted value
  //     reads as "nothing recorded" — the safe direction.
  const failureClass = classifyAgentExit({
    exitCode: facts.exitCode,
    errorFrames: facts.errorFrames,
    recorded: (row.failureClass as FailureClass | null) ?? null,
  });
  const recordedAtFinishStart = row.failureClass;

  // (b) the per-run gbrain token dies with the run (honesty rule 9), before
  //     anything else can fail. Idempotent, so the reclaimer racing here is safe.
  let tokenRevoked = false;
  let revokeError: string | null = null;
  try {
    tokenRevoked = (await revokeRunToken(facts.runId)).revoked;
  } catch (e) {
    revokeError = message(e);
  }

  // (c) COMMIT THE RUN'S WRITES, before the after-heads are read. P8 measured an
  //     MCP `put_page` leaving an untracked file and HEAD unmoved, so this is the
  //     step that makes the range real — and the author is ours (F12: Space
  //     repos have no git identity, so `commitAs` supplies it).
  let commit: { committed: boolean; sha: string | null } | null = null;
  let commitError: string | null = null;
  if (member && writeSpace) {
    try {
      commit = await commitAsMember(writeSpace, member, `agent run ${facts.runId}`);
    } catch (e) {
      commitError = message(e);
    }
  }

  // (d) the after-heads and the diff. A read Space whose range moved is a
  //     FINDING, never a diff row (honesty rule 10) — it is alerted below.
  let diff: DiffSummary | null = null;
  let diffError: string | null = null;
  const before = (row.headsBefore ?? null) as SpaceHeads | null;
  if (!member || !writeSpace) {
    diffError = 'the run\'s Connection is gone, so its range cannot be attributed to anyone';
  } else if (!before) {
    diffError = 'no pre-run heads were recorded, so nothing can be attributed honestly';
  } else {
    try {
      const after = await captureHeads([writeSpace, ...readSpaces]);
      diff = await diffForRun({
        writeSpace, readSpaces, before, after, member, fetchRange: gitRange,
      });
      await db.update(schema.agentRuns)
        .set({ headsAfter: after })
        .where(eq(schema.agentRuns.runId, facts.runId));
    } catch (e) {
      diffError = message(e);
    }
  }

  // The reason is stored on the row (L14). A commit that did not land is an
  // infrastructure failure — the agent's work is not in the brain — while a diff
  // that could not be READ is only a missing report of work that did land, so it
  // is recorded without relabelling the run.
  const effectiveClass: FailureClass | null = failureClass
    ?? (commitError ? 'infra_failed' : null);
  const failureDetail: Record<string, unknown> = {};
  if (effectiveClass) {
    failureDetail.reason = commitError ? 'commit_failed'
      : recordedAtFinishStart ? 'recorded_by_component' : 'harness_reported';
    failureDetail.exitCode = facts.exitCode;
    if (facts.errorFrames) failureDetail.errorFrames = facts.errorFrames;
  }
  if (commitError) failureDetail.commitError = commitError;
  if (diffError) failureDetail.diffError = diffError;
  if (revokeError) failureDetail.tokenRevokeError = revokeError;

  // (e) the rollup: `agent_runs.cost_usd` IS `SUM(agent_run_usage.cost_usd)`.
  const meterTurns = (await db.select({ n: sql<number>`count(*)::int` })
    .from(schema.agentRunUsage)
    .where(eq(schema.agentRunUsage.runId, facts.runId)))[0]?.n ?? 0;
  const numTurns = facts.numTurns ?? meterTurns;
  const turnsFrom = facts.numTurns === undefined ? 'meter' : 'runner';

  // (f) ONE write for the run's own row: the rollup and the classification
  //     together, so the row is never readable in a state where the money and the
  //     reason disagree.
  const [written] = await db.update(schema.agentRuns)
    .set({
      costUsd: sql`(select case when count(*) filter (where cost_usd is null) > 0 then null
                                 else sum(cost_usd::numeric)::text end
                    from agent_run_usage where run_id = ${facts.runId})`,
      inputTokens: rollupTokensSql('input_tokens', facts.runId),
      outputTokens: rollupTokensSql('output_tokens', facts.runId),
      cacheReadTokens: rollupTokensSql('cache_read_tokens', facts.runId),
      cacheWriteTokens: rollupTokensSql('cache_write_tokens', facts.runId),
      numTurns,
      failureClass: effectiveClass,
      failureDetail: Object.keys(failureDetail).length > 0 ? failureDetail : null,
      diffSummary: diff,
    })
    .where(eq(schema.agentRuns.runId, facts.runId))
    .returning({
      costUsd: schema.agentRuns.costUsd,
      inputTokens: schema.agentRuns.inputTokens,
      outputTokens: schema.agentRuns.outputTokens,
      cacheReadTokens: schema.agentRuns.cacheReadTokens,
      cacheWriteTokens: schema.agentRuns.cacheWriteTokens,
    });

  // The schedule's classification, in the ONE vocabulary the column CHECK
  // permits. Two carve-outs, both load-bearing:
  //   * Task 7's meter writes `budget_exceeded`/`refused` so D11 cannot retry a
  //     run it refused to fund — this must never overwrite either;
  //   * `kill_previous` marks its victim `cancelled` while the harness is still
  //     running, and a deliberately ended run is not a failure.
  const KEPT = ['budget_exceeded', 'refused'];
  const cancelled = run.cancelRequested;
  const classification = run.classification && KEPT.includes(run.classification)
    ? run.classification
    : cancelled ? 'cancelled'
      : effectiveClass === null ? 'ok' : CLASSIFICATION_BY_FAILURE[effectiveClass];
  const state = classification === 'cancelled' ? 'cancelled'
    : classification === 'ok' ? 'succeeded' : 'failed';

  await finishRun(facts.runId, {
    state,
    classification,
    exitCode: facts.exitCode,
    // S3c: counts and status only. Never a prompt, never a frame's body, never
    // an argv value.
    summary: {
      costUsd: written?.costUsd ?? null,
      numTurns,
      turnsFrom,
      commits: diff ? diff.write.commits.length : null,
      files: diff ? diff.write.files.length : null,
      concurrentWriters: diff ? diff.write.concurrentWriters : null,
      readSpaceMoves: diff ? diff.readSpaceMoves.map((m) => m.sourceId) : null,
      tokens: {
        input: written?.inputTokens ?? 0,
        output: written?.outputTokens ?? 0,
        cacheRead: written?.cacheReadTokens ?? 0,
        cacheWrite: written?.cacheWriteTokens ?? 0,
      },
      failure: effectiveClass,
    },
  });

  // (g) alerts and the retry row. One alert per cause: a class the meter already
  //     recorded was already alerted when it was written (its `markRunFailed`),
  //     and a second row for the same fact is noise an operator learns to ignore.
  const alertReason = typeof failureDetail.reason === 'string'
    ? failureDetail.reason
    : diffError ? 'diff_failed' : 'unknown';
  const alertDetail: Record<string, unknown> = {
    reason: alertReason,
    classification: effectiveClass,
    exitCode: facts.exitCode,
    costUsd: written?.costUsd ?? null,
    state,
  };
  if (commitError) { alertDetail.commitError = commitError; }
  if (diffError) { alertDetail.diffError = diffError; }
  if (revokeError) { alertDetail.tokenRevokeError = revokeError; }

  if ((effectiveClass !== null && recordedAtFinishStart === null) || commitError || diffError) {
    await raiseAgentAlert({
      organizationId: row.organizationId,
      scheduleId: run.scheduleId,
      runId: facts.runId,
      kind: AGENT_ALERT_KINDS.runFailed,
      detail: alertDetail,
    });
  }
  if (diff && diff.readSpaceMoves.length > 0) {
    await raiseAgentAlert({
      organizationId: row.organizationId,
      // Org-level by design (alerts.ts): the finding is that read isolation
      // broke under a run, which is about the deployment, not this schedule.
      scheduleId: null,
      runId: facts.runId,
      kind: AGENT_ALERT_KINDS.readSpaceMoved,
      detail: {
        moves: diff.readSpaceMoves,
        note: 'a read Space that changed during a run is a finding, not a diff row (honesty rule 10)',
      },
    });
  }

  const retry = effectiveClass === null || cancelled
    ? null
    : await createRetryRow({
      scheduleId: run.scheduleId,
      organizationId: run.organizationId,
      slot: run.slot,
      attempt: run.attempt,
      failureClass: effectiveClass,
      nowMs,
    });

  return {
    ok: true,
    result: {
      runId: facts.runId,
      state,
      classification,
      failureClass: effectiveClass,
      failureReason: typeof failureDetail.reason === 'string' ? failureDetail.reason : null,
      costUsd: written?.costUsd ?? null,
      tokens: {
        input: written?.inputTokens ?? 0,
        output: written?.outputTokens ?? 0,
        cacheRead: written?.cacheReadTokens ?? 0,
        cacheWrite: written?.cacheWriteTokens ?? 0,
      },
      numTurns,
      tokenRevoked,
      commit,
      diff,
      retry,
    },
  };
}

// --- retries (D11) -----------------------------------------------------------

/**
 * D11: a retry is a NEW `schedule_runs` row with `attempt = n + 1` and slot
 * `<slot>#r<n+1>`, so the UNIQUE `(schedule_id, slot)` idempotency key still
 * holds and the FAILED attempt stays in history instead of being overwritten.
 * The failed row is never mutated.
 *
 * Idempotent on replay: a second finish for the same run finds the row and
 * returns it rather than failing on the unique key.
 */
export async function createRetryRow(args: {
  scheduleId: string;
  organizationId: string;
  slot: string;
  attempt: number;
  failureClass: FailureClass;
  nowMs: number;
}): Promise<{ runId: string; attempt: number } | null> {
  const decision = retryPolicyFor(args.failureClass, args.attempt);
  if (!decision.retry || decision.nextAttempt === null) return null;

  const db = getDb();
  const slot = `${args.slot}#r${decision.nextAttempt}`;
  const id = randomUUID();
  const inserted = await db.insert(schema.scheduleRuns)
    .values({
      id,
      scheduleId: args.scheduleId,
      organizationId: args.organizationId,
      slot,
      // Due now: the retry is the same work again, not a new slot on the clock.
      fireAt: new Date(args.nowMs),
      state: 'pending',
      attempt: decision.nextAttempt,
    })
    .onConflictDoNothing({ target: [schema.scheduleRuns.scheduleId, schema.scheduleRuns.slot] })
    .returning({ id: schema.scheduleRuns.id });
  if (inserted[0]) return { runId: inserted[0].id, attempt: decision.nextAttempt };

  const [existing] = await db.select({ id: schema.scheduleRuns.id })
    .from(schema.scheduleRuns)
    .where(and(
      eq(schema.scheduleRuns.scheduleId, args.scheduleId),
      eq(schema.scheduleRuns.slot, slot),
    ));
  return existing ? { runId: existing.id, attempt: decision.nextAttempt } : null;
}

// --- internals ---------------------------------------------------------------

/**
 * One token counter's rollup. `agent_runs.cost_usd` and the four token columns
 * are DEFINED as aggregates over `agent_run_usage`, and the cost half is the same
 * expression `recordUsage` applies incrementally (`src/gateway/meter.ts`): `null`
 * when ANY metered row could not be priced — never a partial sum presented as the
 * run's cost (honesty rule 3) — and `null` when there are no rows at all, because
 * "we have not priced this" is not "this was free". `accruedCost` reads zero rows
 * as `0` for the CAP's benefit; the row is the ledger, and the ledger says
 * unknown.
 */
function rollupTokensSql(column: string, runId: string) {
  return sql`(select coalesce(sum(${sql.raw(column)}), 0)::int
              from agent_run_usage where run_id = ${runId})`;
}

/**
 * The schedule's agent payload, resolved into a run's spec. Money and the pin
 * come from the ROW, never from a request body — the runner does not get to
 * choose its own budget or model.
 */
function specOf(
  schedule: ScheduleRow,
  run: RunRow,
  connection: ConnectionRow,
  member: { name: string; email: string },
  writeSpace: string,
  readSpaces: Array<{ sourceId: string }>,
): AgentRunSpec {
  return {
    scheduleId: schedule.id,
    attempt: run.attempt,
    organizationId: schedule.organizationId,
    connectionId: connection.id,
    member,
    writeSpace,
    readSpaces: readSpaces.map((s) => s.sourceId),
    prompt: schedule.agentPrompt ?? '',
    model: schedule.agentModel ?? '',
    maxTokens: schedule.agentMaxTokens ?? 0,
    budgetUsd: schedule.agentBudgetUsd ?? '0',
    harnessVersion: schedule.agentHarnessVersion ?? '',
    timeoutSeconds: schedule.timeoutSeconds,
  };
}

type AgentContext =
  | {
    refusal: AgentClaimRefusal;
    /** A precondition is `refused`; a broken dependency is `infra_failed`. */
    failureClass: FailureClass;
  }
  | {
    connection: ConnectionRow;
    member: { name: string; email: string };
    writeSpace: { id: string; sourceId: string };
    readSpaces: Array<{ id: string; sourceId: string }>;
  };

/**
 * Resolve the schedule's Connection, its member and its Spaces. Every failure
 * here is a REFUSAL with its own code rather than a thrown error: "no active
 * Connection" is D11's `refused` — a retry cannot fix a precondition.
 */
async function loadAgentContext(schedule: ScheduleRow, run: RunRow): Promise<AgentContext> {
  const db = getDb();
  const refuse = (refusal: AgentClaimRefusal): AgentContext => ({
    refusal, failureClass: 'refused',
  });

  if (!schedule.connectionId) {
    return refuse({
      error: 'connection_inactive', runId: run.id, scheduleId: schedule.id, connectionId: null,
      connectionState: null,
      detail: 'the schedule has no Connection — it was revoked',
    });
  }
  const [connection] = await db.select().from(schema.connections)
    .where(eq(schema.connections.id, schedule.connectionId));
  if (!connection) {
    return refuse({
      error: 'connection_inactive', runId: run.id, scheduleId: schedule.id,
      connectionId: schedule.connectionId, connectionState: null,
      detail: `connection ${schedule.connectionId} no longer exists`,
    });
  }
  if (connection.state !== 'active') {
    return refuse({
      error: 'connection_inactive', runId: run.id, scheduleId: schedule.id,
      connectionId: connection.id, connectionState: connection.state,
      detail: `connection ${connection.id} is ${connection.state}, not active`,
    });
  }

  const [identity] = await db.select({ name: schema.users.name, email: schema.users.email })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.id, connection.membershipId));
  if (!identity) {
    return refuse({
      error: 'connection_broken', runId: run.id, scheduleId: schedule.id,
      connectionId: connection.id, connectionState: connection.state,
      detail: `membership ${connection.membershipId} has no user to attribute the run to`,
    });
  }

  const ids = [...new Set([connection.writeSpaceId, ...readSpaceIds(connection.readSpaceIds)])];
  const spaces = await db.select({ id: schema.spaces.id, sourceId: schema.spaces.sourceId })
    .from(schema.spaces)
    .where(inArray(schema.spaces.id, ids));
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const writeSpace = byId.get(connection.writeSpaceId);
  if (!writeSpace) {
    return refuse({
      error: 'connection_broken', runId: run.id, scheduleId: schedule.id,
      connectionId: connection.id, connectionState: connection.state,
      detail: `write Space ${connection.writeSpaceId} no longer exists`,
    });
  }
  // A missing read Space is not skippable: dropping it would silently narrow the
  // run's read scope, which is the isolation the Connection exists to state.
  const reads: Array<{ id: string; sourceId: string }> = [];
  for (const id of ids.filter((i) => i !== connection.writeSpaceId)) {
    const space = byId.get(id);
    if (!space) {
      return refuse({
        error: 'connection_broken', runId: run.id, scheduleId: schedule.id,
        connectionId: connection.id, connectionState: connection.state,
        detail: `read Space ${id} no longer exists`,
      });
    }
    reads.push(space);
  }

  return {
    connection,
    member: { name: identity.name ?? identity.email, email: identity.email },
    writeSpace,
    readSpaces: reads,
  };
}

/** jsonb `read_space_ids` is free-form; anything that is not a string is not an id. */
function readSpaceIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * D9's single-flight, as one query: another `agent_prompt` run of the same
 * organization whose schedule writes the same Space and whose lease is still
 * live. `pending` runs are not holders — they have not been claimed.
 */
async function findWriteSpaceHolder(
  connection: ConnectionRow,
  exceptRunId: string,
  nowMs: number,
): Promise<{ id: string; scheduleId: string; claimedBy: string | null; leaseExpiresAt: Date | null } | null> {
  const [holder] = await getDb().select({
    id: schema.scheduleRuns.id,
    scheduleId: schema.scheduleRuns.scheduleId,
    claimedBy: schema.scheduleRuns.claimedBy,
    leaseExpiresAt: schema.scheduleRuns.leaseExpiresAt,
  })
    .from(schema.scheduleRuns)
    .innerJoin(schema.schedules, eq(schema.schedules.id, schema.scheduleRuns.scheduleId))
    .innerJoin(schema.connections, eq(schema.connections.id, schema.schedules.connectionId))
    .where(and(
      eq(schema.scheduleRuns.state, 'running'),
      gt(schema.scheduleRuns.leaseExpiresAt, new Date(nowMs)),
      eq(schema.schedules.jobType, 'agent_prompt'),
      eq(schema.connections.writeSpaceId, connection.writeSpaceId),
      ne(schema.scheduleRuns.id, exceptRunId),
    ))
    .orderBy(asc(schema.scheduleRuns.startedAt))
    .limit(1);
  return holder ?? null;
}

/**
 * Consume a claimed occurrence as a refusal, in D11's vocabulary, and record the
 * reason where L14 says reasons live: on the row.
 *
 * For `infra_failed` a retry row is created (`retryPolicyFor`, cap 2) so a
 * transient ops failure does not cost the run; for `refused` it never is,
 * because a retry cannot fix a precondition.
 */
async function refuseRun(args: {
  run: RunRow;
  schedule: ScheduleRow;
  failureClass: FailureClass;
  reason: string;
  detail: string;
  connectionId: string | null;
  alertKind: AgentAlertKind;
  alertScheduleId: string | null;
  nowMs: number;
  refusal: AgentClaimRefusal;
}): Promise<AgentClaimOutcome> {
  const db = getDb();
  const failureDetail = {
    reason: args.reason,
    detail: args.detail,
    connectionId: args.connectionId,
  };

  // The row exists only after a successful mint; a refusal before that has no
  // agent_runs row to stamp, and inventing one would claim a run was minted.
  await db.update(schema.agentRuns)
    .set({ failureClass: args.failureClass, failureDetail })
    .where(and(
      eq(schema.agentRuns.runId, args.run.id),
      isNull(schema.agentRuns.failureClass),
    ));

  await finishRun(args.run.id, {
    state: 'failed',
    classification: CLASSIFICATION_BY_FAILURE[args.failureClass],
    summary: { error: args.reason, detail: args.detail },
  });

  await raiseAgentAlert({
    organizationId: args.schedule.organizationId,
    scheduleId: args.alertScheduleId,
    runId: args.run.id,
    kind: args.alertKind,
    detail: failureDetail,
  });

  const retry = await createRetryRow({
    scheduleId: args.schedule.id,
    organizationId: args.schedule.organizationId,
    slot: args.run.slot,
    attempt: args.run.attempt,
    failureClass: args.failureClass,
    nowMs: args.nowMs,
  });
  if (retry) {
    await db.update(schema.scheduleRuns)
      .set({ summary: { error: args.reason, detail: args.detail, retryRunId: retry.runId } })
      .where(eq(schema.scheduleRuns.id, args.run.id));
  }

  return { status: 'refused', refusal: args.refusal };
}

/** FailureClass → `schedule_runs.classification`. The two vocabularies agree on
 *  every word (Task 4 widened the CHECK so they could), and this map is the one
 *  place that says so. */
const CLASSIFICATION_BY_FAILURE: Record<FailureClass, string> = {
  budget_exceeded: 'budget_exceeded',
  agent_failed: 'agent_failed',
  infra_failed: 'infra_failed',
  timeout: 'timeout',
  refused: 'refused',
};

/**
 * Kill a client we minted but could not record (`agent_runs` insert failed, so
 * `revokeRunToken` has no row to claim). `killRunClient` in `./token.ts` is
 * private and row-based; this is the same two published ops, for the one path
 * that must not leave a live credential behind (honesty rule 9). Best-effort:
 * the failure is the caller's error, and the minted TTL bounds the rest.
 */
async function killOrphanClient(clientId: string): Promise<void> {
  try {
    await callOps('auth.revokeClient', { clientId });
    await deleteCredentialJournal(clientId);
  } catch {
    // Nothing better to do: the client's own TTL is the backstop.
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
