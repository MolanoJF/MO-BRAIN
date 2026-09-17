/**
 * The meter: the enforcement point for D7's cap, and the authority on what a run cost.
 *
 * `accruedCost` / `assertBudget` / `recordUsage` are the DB half; `StreamMeter` is the streaming half
 * — a pure state machine over the upstream SSE events, so the cap check runs as the bytes pass
 * through rather than after the response is buffered (honesty rule 4).
 *
 * Two numbers, two meanings, one vocabulary (U9):
 *   * gbrain's `budget_usd_per_day` caps **gbrain's own** model calls per OAuth client, metered in
 *     gbrain's tables. We never read or write those.
 *   * `agent_runs.budget_usd` caps **the harness's** calls through this gateway, metered here in
 *     `agent_run_usage`. This module only ever touches the second.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { AGENT_ALERT_KINDS, raiseAgentAlert, type AgentAlertKind } from '../agent/alerts.ts';
import { getDb, schema } from '../control/db/client.ts';
import { priceCounts, rateFor, usageCounts, type UsageCounts } from './pricing.ts';

export type AgentRunRow = typeof schema.agentRuns.$inferSelect;

/** `schedule_runs.state` values a model call may still happen under. Everything else is terminal. */
const LIVE_RUN_STATES = ['pending', 'running'];

export type RefusalCode =
  | 'budget_exceeded'
  | 'budget_unknowable'
  | 'run_terminated'
  | 'run_unknown';

/**
 * D7 step 1's refusal. Thrown before an upstream connection exists; the route renders
 * `{ type: 'error', error: { type, message } }` with `status`, which is the shape an
 * Anthropic-shaped client already understands.
 *
 * A refusal is never silent: on the budget paths this also marks the run and raises the alert.
 */
export class GatewayRefusal extends Error {
  readonly code: RefusalCode;
  readonly status: 402 | 401;
  readonly anthropicType: string;
  readonly detail: Record<string, unknown>;

  constructor(
    code: RefusalCode,
    status: 402 | 401,
    anthropicType: string,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GatewayRefusal';
    this.code = code;
    this.status = status;
    this.anthropicType = anthropicType;
    this.detail = detail;
  }
}

/**
 * The run's cost so far, summed from `agent_run_usage` — the table the schema names as the budget's
 * authority. `null` when **any** row could not be priced: a cap computed over an unknown term is not
 * a cap (honesty rules 3 and 4). Zero rows is `0`: nothing spent is a known amount.
 */
export async function accruedCost(runId: string): Promise<number | null> {
  const rows = await getDb().select({ costUsd: schema.agentRunUsage.costUsd })
    .from(schema.agentRunUsage).where(eq(schema.agentRunUsage.runId, runId));
  if (rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    if (row.costUsd === null) return null;
    total += Number(row.costUsd);
  }
  return Math.round(total * 1e7) / 1e7;
}

export type BudgetVerdict = {
  run: AgentRunRow;
  scheduleId: string | null;
  budgetUsd: number;
  accruedUsd: number;
  remainingUsd: number;
};

/**
 * D7 step 1, in one call: load the run (the lookup that also burns a dead token), price the run's
 * accrued spend, and refuse when the cap is reached or unknowable.
 *
 * The refusal path **marks the run and raises the alert here**, so a 402 always leaves a row and an
 * alert behind — there is no caller that can refuse quietly.
 */
export async function assertBudget(runId: string): Promise<BudgetVerdict> {
  const [row] = await getDb().select({
    run: schema.agentRuns,
    state: schema.scheduleRuns.state,
    scheduleId: schema.scheduleRuns.scheduleId,
  })
    .from(schema.agentRuns)
    .innerJoin(schema.scheduleRuns, eq(schema.scheduleRuns.id, schema.agentRuns.runId))
    .where(eq(schema.agentRuns.runId, runId));

  // A token for a run that does not exist is not a valid credential.
  if (!row) {
    throw new GatewayRefusal('run_unknown', 401, 'authentication_error', 'unknown run');
  }
  // Honesty rule 9: the token dies with the run. Checked on every request, because every request
  // already does this lookup.
  if (row.run.tokenRevokedAt || !LIVE_RUN_STATES.includes(row.state)) {
    throw new GatewayRefusal(
      'run_terminated', 401, 'authentication_error',
      `run ${runId} is not live (token revoked or state ${row.state})`,
      { state: row.state, tokenRevokedAt: row.run.tokenRevokedAt },
    );
  }

  const budgetUsd = Number(row.run.budgetUsd);
  const accruedUsd = await accruedCost(runId);
  const target = {
    runId,
    scheduleId: row.scheduleId,
    organizationId: row.run.organizationId,
    currentFailureClass: row.run.failureClass,
  };

  if (!Number.isFinite(budgetUsd)) {
    await markRunFailed({
      ...target, alertKind: AGENT_ALERT_KINDS.budgetExceeded, event: 'budget_unknowable',
      detail: { budgetUsd: row.run.budgetUsd, accruedUsd },
    });
    throw new GatewayRefusal(
      'budget_unknowable', 402, 'budget_exceeded',
      `run ${runId} has an unreadable budget; refusing the call`,
      { budgetUsd: row.run.budgetUsd, accruedUsd },
    );
  }
  if (accruedUsd === null) {
    await markRunFailed({
      ...target, alertKind: AGENT_ALERT_KINDS.budgetExceeded, event: 'budget_unknowable',
      detail: { budgetUsd, accruedUsd: null },
    });
    throw new GatewayRefusal(
      'budget_unknowable', 402, 'budget_exceeded',
      `run ${runId} has a call that could not be priced; the remaining budget is unknowable`,
      { budgetUsd, accruedUsd: null },
    );
  }
  if (accruedUsd >= budgetUsd) {
    await markRunFailed({
      ...target, alertKind: AGENT_ALERT_KINDS.budgetExceeded, event: 'budget_exceeded',
      detail: { budgetUsd, accruedUsd },
    });
    throw new GatewayRefusal(
      'budget_exceeded', 402, 'budget_exceeded',
      `run ${runId} has spent $${accruedUsd} of its $${budgetUsd} budget`,
      { budgetUsd, accruedUsd },
    );
  }
  return { run: row.run, scheduleId: row.scheduleId, budgetUsd, accruedUsd, remainingUsd: budgetUsd - accruedUsd };
}

export type RunFailureMark = {
  runId: string;
  scheduleId: string | null;
  organizationId: string;
  /** The value already on the row, so a repeated refusal raises exactly one alert. */
  currentFailureClass: string | null;
  /** One of `AGENT_ALERT_KINDS` — the console registers kinds by hand, so they live in one place. */
  alertKind: AgentAlertKind;
  /** S3c: counts and status only — never a message body. */
  detail: Record<string, unknown>;
  event: 'budget_exceeded' | 'budget_unknowable' | 'model_unpriced';
};

/**
 * Mark the run and raise the alert. `agent_runs.failure_class` is the authoritative reason (L14:
 * reasons live on the row, never reconstructed by a renderer); `schedule_runs.classification` is set
 * only when it is still null, so D11's `retryPolicyFor` cannot read a null and retry a run the meter
 * refused to fund.
 */
export async function markRunFailed(mark: RunFailureMark): Promise<void> {
  const db = getDb();
  const failureClass = mark.event === 'model_unpriced' ? 'refused' : 'budget_exceeded';
  await db.update(schema.agentRuns)
    .set({ failureClass, failureDetail: { reason: mark.event, ...mark.detail } })
    .where(eq(schema.agentRuns.runId, mark.runId));
  await db.update(schema.scheduleRuns)
    .set({ classification: failureClass })
    .where(sql`${schema.scheduleRuns.id} = ${mark.runId} and ${schema.scheduleRuns.classification} is null`);

  // One alert per run: the first refusal is the event; the rest are the same fact restated.
  if (mark.currentFailureClass === failureClass) return;
  await raiseAgentAlert({
    organizationId: mark.organizationId,
    scheduleId: mark.scheduleId,
    runId: mark.runId,
    kind: mark.alertKind,
    detail: { reason: mark.event, ...mark.detail },
  });
}

export type UsageRowInput = {
  runId: string;
  model: string;
  counts: UsageCounts;
  /** `null` when the call could not be priced — never `0` (honesty rule 3). */
  costUsd: number | null;
  stopReason?: string | null;
  httpStatus?: number | null;
  /** Explicit seq replays one already-written row idempotently (UNIQUE `(run_id, seq)`). */
  seq?: number;
};

export type UsageRow = { id: string; seq: number };

/**
 * Write one metered call and roll `agent_runs` up to the SUM of `agent_run_usage`
 * (`agent_runs.cost_usd` is defined as that rollup, and is NULL when any row is).
 *
 * `seq` is allocated inside the insert (`max(seq) + 1`) and a lost race retries, so two concurrent
 * requests for one run can never collide on the unique key.
 */
export async function recordUsage(input: UsageRowInput): Promise<UsageRow> {
  const db = getDb();
  const id = randomUUID();
  const c = input.counts;
  let seq: number | null = null;

  for (let attempt = 0; attempt < 5 && seq === null; attempt += 1) {
    const rows: Array<{ seq: number }> = input.seq === undefined
      ? await db.execute(sql`
          insert into agent_run_usage
            (id, run_id, seq, model, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, cost_usd, stop_reason, http_status)
          select ${id}, ${input.runId}, coalesce(max(seq), 0) + 1, ${input.model},
                 ${c.inputTokens}, ${c.outputTokens}, ${c.cacheReadTokens},
                 ${c.cacheWrite5mTokens + c.cacheWrite1hTokens},
                 ${input.costUsd === null ? null : input.costUsd.toFixed(7)},
                 ${input.stopReason ?? null}, ${input.httpStatus ?? null}
          from agent_run_usage where run_id = ${input.runId}
          on conflict (run_id, seq) do nothing
          returning seq
        `)
      : await db.execute(sql`
          insert into agent_run_usage
            (id, run_id, seq, model, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, cost_usd, stop_reason, http_status)
          values (${id}, ${input.runId}, ${input.seq}, ${input.model},
                  ${c.inputTokens}, ${c.outputTokens}, ${c.cacheReadTokens},
                  ${c.cacheWrite5mTokens + c.cacheWrite1hTokens},
                  ${input.costUsd === null ? null : input.costUsd.toFixed(7)},
                  ${input.stopReason ?? null}, ${input.httpStatus ?? null})
          on conflict (run_id, seq) do nothing
          returning seq
        `);
    seq = rows[0]?.seq ?? null;
  }
  if (seq === null) throw new Error(`agent_run_usage seq allocation lost 5 races for run ${input.runId}`);

  await db.execute(sql`
    update agent_runs set
      cost_usd =
        (select case when count(*) filter (where cost_usd is null) > 0 then null
                     else sum(cost_usd::numeric)::text end
         from agent_run_usage where run_id = ${input.runId}),
      input_tokens =
        (select coalesce(sum(input_tokens), 0)::int from agent_run_usage where run_id = ${input.runId}),
      output_tokens =
        (select coalesce(sum(output_tokens), 0)::int from agent_run_usage where run_id = ${input.runId}),
      cache_read_tokens =
        (select coalesce(sum(cache_read_tokens), 0)::int from agent_run_usage where run_id = ${input.runId}),
      cache_write_tokens =
        (select coalesce(sum(cache_write_tokens), 0)::int from agent_run_usage where run_id = ${input.runId})
    where run_id = ${input.runId}
  `);
  return { id, seq };
}

/** What the log line is allowed to carry (S3c): counts and status, never content. */
export function totalTokens(counts: UsageCounts): number {
  return counts.inputTokens + counts.outputTokens + counts.cacheReadTokens
    + counts.cacheWrite5mTokens + counts.cacheWrite1hTokens;
}

export type MeterObservation = 'ok' | 'cap_crossed' | 'model_unpriced';

/**
 * The mid-stream meter. It sees the upstream events **in the order they arrive** — `message_start`
 * carries the exact input/cache counts (the dominant cost of one expensive request), `message_delta`
 * the exact output count, and every content delta is counted as a byte upper bound, because a token
 * is at least one byte: the bound can fire the cap early, never late.
 *
 * Nothing here touches the DB, so the cap logic is unit-testable without a Postgres.
 */
export class StreamMeter {
  private model: string;
  private readonly budgetUsd: number;
  private readonly accruedUsd: number;
  private counts: UsageCounts = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
  };
  private outputBoundTokens = 0;
  private sawUsage = false;
  stopReason: string | null = null;
  crossed = false;
  unpricedModel: string | null = null;

  constructor(opts: { model: string; budgetUsd: number; accruedUsd: number }) {
    this.model = opts.model;
    this.budgetUsd = opts.budgetUsd;
    this.accruedUsd = opts.accruedUsd;
  }

  /** The model this call is billed at: the response's own id once seen, else the requested one. */
  get pricedModel(): string {
    return this.model;
  }

  /** One parsed SSE payload (the JSON after `data: `). */
  observe(payload: unknown): MeterObservation {
    if (!payload || typeof payload !== 'object') return 'ok';
    const event = payload as {
      type?: string;
      message?: { model?: unknown; usage?: never };
      usage?: never;
      delta?: unknown;
    };

    if (event.type === 'message_start') {
      const reported = (event.message as { model?: unknown } | undefined)?.model;
      // The response's own model id is authoritative (the alias `haiku` resolves to a dated id).
      if (typeof reported === 'string' && reported) this.model = reported;
      this.counts = { ...this.counts, ...usageCounts(event.message?.usage) };
      this.sawUsage = true;
    } else if (event.type === 'message_delta') {
      const exact = usageCounts(event.usage);
      if (exact.outputTokens) this.counts.outputTokens = exact.outputTokens;
      this.sawUsage = true;
      const stop = (event.delta as { stop_reason?: unknown } | undefined)?.stop_reason;
      if (typeof stop === 'string') this.stopReason = stop;
    } else if (event.type === 'content_block_delta' || event.type === 'content_block_start') {
      // A token is at least one byte of the serialized delta, so byte length upper-bounds the tokens
      // this delta can bill for. Conservative by construction: early is allowed, late is not.
      this.outputBoundTokens += Buffer.byteLength(JSON.stringify(event.delta ?? ''), 'utf8');
    }

    if (rateFor(this.model) === null) {
      this.unpricedModel = this.model;
      return 'model_unpriced';
    }
    if (this.accruedUsd + this.capCost() >= this.budgetUsd) {
      this.crossed = true;
      return 'cap_crossed';
    }
    return 'ok';
  }

  /** The exact cost of what has actually been reported. `null` if nothing priceable was reported. */
  pricedCost(): number | null {
    if (!this.sawUsage) return null;
    return priceCounts(this.model, this.counts);
  }

  /**
   * What a run that was cut off mid-message spent: the exact input/cache counts plus the output
   * byte-bound. An upper bound, never an undercount — a cap that reports having spent less than it
   * did is the same lie as a cap that does not fire.
   */
  boundedSnapshot(): { counts: UsageCounts; costUsd: number | null } {
    const counts = { ...this.counts, outputTokens: Math.max(this.counts.outputTokens, this.outputBoundTokens) };
    return { counts, costUsd: priceCounts(this.model, counts) };
  }

  /** Cost including the output-token upper bound: what the cap check uses mid-message. */
  private capCost(): number {
    return this.boundedSnapshot().costUsd ?? 0;
  }

  snapshot(): UsageCounts {
    return { ...this.counts };
  }

  /** `false` when a 200 carried no usage frame at all: the call happened and we cannot meter it. */
  get sawAnyUsage(): boolean {
    return this.sawUsage;
  }
}
