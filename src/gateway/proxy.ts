/**
 * D7's proxy: the harness's model calls pass through here, and this is where the cap is enforced.
 *
 * Order of operations — the order is the decision:
 *
 *   1. `assertBudget(runId)` (via `meter.ts`) — before anything else, and before an upstream
 *      connection exists. The same lookup burns a token whose run has ended (honesty rule 9).
 *   2. `readSecret(orgId, 'anthropic_api_key')` — in process, never logged, never handed to the
 *      runner, never written to the file plane (S3b). U12: this is `readSecret`'s first caller.
 *   3. Price the call before forwarding it. A model the pinned table cannot price is a call we
 *      cannot cap, so it is not made (honesty rule 3). D7 lists this last; a refusal that has to
 *      happen *before* the forward cannot be implemented after it.
 *   4. Forward and stream. The usage frames are parsed **as they pass through** — the bytes reach the
 *      harness untouched while a decoded copy is metered — and every metered call lands in
 *      `agent_run_usage`.
 *   5. Mid-stream: if the run's accrued cost crosses the cap during the stream, close the upstream
 *      connection, emit a terminal error event, and end the run `budget_exceeded` (honesty rule 4).
 *      A cap that only fires between requests is not a cap for one expensive request.
 *
 * S3c: **this file must never log a request body, a header, or a URL with query params.** The only
 * log line it emits is `{runId, model, status, tokens, costUsd}` — see `GatewayLog`.
 */
import { AGENT_ALERT_KINDS } from '../agent/alerts.ts';
import { readSecret } from '../control/secrets.ts';
import {
  assertBudget, GatewayRefusal, markRunFailed, recordUsage, StreamMeter, totalTokens,
  type BudgetVerdict,
} from './meter.ts';
import { PRICED_AT, rateFor, type UsageCounts } from './pricing.ts';

export type MessagesRequest = {
  runId: string;
  /** The request body, forwarded byte-for-byte. Never logged. */
  body: string;
  /** `model` from that body — the id the harness asks the upstream for. */
  model: string;
  /** The incoming query string, preserved exactly (`?beta=true`, per P3). */
  query: string;
  /** The client's headers, forwarded only through the allowlist below. Never logged. */
  clientHeaders: Headers;
  /** `stream: false` bodies are metered from the single JSON response instead. */
  stream: boolean;
};

export type GatewayLog = {
  runId: string;
  model: string;
  status: number;
  tokens: number;
  costUsd: number | null;
};

export type GatewayDeps = {
  upstreamBaseUrl?: string;
  fetchUpstream?: typeof fetch;
  /** Injectable so a test can exercise the route without an org secret; the default is the real read. */
  readUpstreamSecret?: (orgId: string, name: string) => Promise<string | null>;
  log?: (line: GatewayLog) => void;
};

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
const SECRET_NAME = 'anthropic_api_key';

/**
 * Anthropic's OAuth beta. The value is not a guess: the pinned harness binary (2.1.274) defines it as
 * `oauth_auth -> "oauth-2025-04-20"`, and a live call through this proxy with the host's OAuth
 * credential proves the upstream accepts it (see the findings' Task 7 note).
 */
const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * Only headers the upstream needs, all of them Anthropic's own contract. The gateway's bearer is
 * deliberately absent — it is spent on leg one, and the upstream credential is added below.
 */
const FORWARDED_HEADERS = [
  'content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'user-agent', 'x-app',
  'x-claude-code-session-id',
];

const encoder = new TextEncoder();

const ZERO_COUNTS: UsageCounts = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
};

/**
 * Which header carries the upstream credential.
 *
 * The plan's rule — "a value starting `sk-ant-` goes out as `x-api-key`; anything else as `Bearer`" —
 * is **wrong**, and a live call proved it: the host's Claude Code OAuth access token measures
 * `sk-ant-oat01-…` (108 chars), so an `sk-ant-` test would have sent the OAuth token as an API key.
 * The discriminator is the segment after the prefix: **`sk-ant-api…` is an API key**; every other
 * shape (`sk-ant-oat…`, or anything unexpected) is presented as a Bearer credential with Anthropic's
 * OAuth beta, which is the lane the real credential needs.
 */
const API_KEY_PREFIX = 'sk-ant-api';
export function upstreamAuth(key: string, currentBeta: string | null): Record<string, string> {
  if (key.startsWith(API_KEY_PREFIX)) return { 'x-api-key': key };
  const betas = (currentBeta ?? '').split(',').map((b) => b.trim()).filter(Boolean);
  if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
  return { authorization: `Bearer ${key}`, 'anthropic-beta': betas.join(',') };
}

function upstreamHeaders(client: Headers, key: string): Headers {
  const out = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = client.get(name);
    if (value) out.set(name, value);
  }
  if (!out.has('anthropic-version')) out.set('anthropic-version', '2023-06-01');
  for (const [name, value] of Object.entries(upstreamAuth(key, out.get('anthropic-beta')))) {
    out.set(name, value);
  }
  return out;
}

/** The Anthropic-shaped error an operator's client already understands. Never echoes the body. */
export function refusalResponse(refusal: GatewayRefusal): Response {
  return Response.json(
    { type: 'error', error: { type: refusal.anthropicType, message: refusal.message, code: refusal.code } },
    { status: refusal.status },
  );
}

/** One line, five keys, no content (S3c). `status` is the gateway's decision for this exchange. */
export function logGatewayLine(line: GatewayLog): void {
  console.log('[gateway]', JSON.stringify(line));
}

type RefusalRecord = {
  event: 'budget_exceeded' | 'model_unpriced';
  /** The model the call named — the requested id, or the response's own once it was seen. */
  model: string;
  detail: Record<string, unknown>;
  counts: UsageCounts;
  /** `null` when the call could not be priced — never a fake `0` (honesty rule 3). */
  costUsd: number | null;
};

/**
 * The one refusal path, shared by the pre-forward check and a mid-stream crossing: mark the run,
 * raise the alert, and record the call in `agent_run_usage` — with the tokens we actually metered
 * when the call had already started, and with `cost_usd = null` when we could not price it.
 *
 * An unpriced model alerts as `agent_run_failed` rather than a kind of its own: the alert vocabulary
 * is closed and registered by hand in the console (`src/agent/alerts.ts`), and the precise reason —
 * `model_unpriced`, with the model id — lives on the run row's `failure_detail` and in the alert's
 * detail, where L14 says a reason belongs.
 */
async function refuseRun(
  verdict: BudgetVerdict,
  record: RefusalRecord,
  status: 400 | 402,
  log: (line: GatewayLog) => void,
): Promise<void> {
  await markRunFailed({
    runId: verdict.run.runId,
    scheduleId: verdict.scheduleId,
    organizationId: verdict.run.organizationId,
    currentFailureClass: verdict.run.failureClass,
    alertKind: record.event === 'model_unpriced'
      ? AGENT_ALERT_KINDS.runFailed
      : AGENT_ALERT_KINDS.budgetExceeded,
    detail: record.detail,
    event: record.event,
  });
  await recordUsage({
    runId: verdict.run.runId,
    model: record.model,
    counts: record.counts,
    costUsd: record.costUsd,
    stopReason: null,
    httpStatus: status,
  });
  log({
    runId: verdict.run.runId,
    model: record.model,
    status,
    tokens: totalTokens(record.counts),
    costUsd: record.costUsd,
  });
}

/**
 * D7 steps 1-5 in order. Returns the response the harness receives: the upstream stream untouched,
 * or an Anthropic-shaped refusal.
 */
export async function proxyMessages(req: MessagesRequest, deps: GatewayDeps = {}): Promise<Response> {
  const log = deps.log ?? logGatewayLine;
  const readUpstreamSecret = deps.readUpstreamSecret ?? readSecret;
  const fetchUpstream = deps.fetchUpstream ?? fetch;
  const upstreamBaseUrl = (deps.upstreamBaseUrl ?? process.env.GATEWAY_UPSTREAM_URL ?? DEFAULT_UPSTREAM)
    .replace(/\/+$/, '');

  // Step 1 — the cap, and the token's life, before an upstream connection exists.
  let verdict: BudgetVerdict;
  try {
    verdict = await assertBudget(req.runId);
  } catch (e) {
    if (e instanceof GatewayRefusal) {
      log({ runId: req.runId, model: req.model, status: e.status, tokens: 0, costUsd: null });
      return refusalResponse(e);
    }
    throw e;
  }

  // Step 2 — the org's upstream credential. In process; it never leaves this function's frame.
  const secret = await readUpstreamSecret(verdict.run.organizationId, SECRET_NAME);
  if (!secret) {
    log({ runId: req.runId, model: req.model, status: 503, tokens: 0, costUsd: null });
    return Response.json({
      type: 'error',
      error: {
        type: 'api_error',
        message: `no ${SECRET_NAME} is stored for this organization; the gateway has no upstream credential`,
        code: 'gateway_misconfigured',
      },
    }, { status: 503 });
  }

  // Step 3 — a call we cannot price is a call we do not make.
  if (!rateFor(req.model)) {
    await refuseRun(verdict, {
      event: 'model_unpriced', model: req.model,
      detail: { model: req.model, pricedAt: PRICED_AT },
      counts: ZERO_COUNTS, costUsd: null,
    }, 400, log);
    return Response.json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `model ${req.model} is absent from MODEL_PRICING (pinned at ${PRICED_AT}); `
          + 'the gateway refuses a call it cannot cap',
        code: 'model_unpriced',
      },
    }, { status: 400 });
  }

  // Step 4 — forward.
  const abort = new AbortController();
  let upstream: Response;
  try {
    upstream = await fetchUpstream(`${upstreamBaseUrl}/v1/messages${req.query}`, {
      method: 'POST',
      headers: upstreamHeaders(req.clientHeaders, secret),
      body: req.body,
      signal: abort.signal,
    });
  } catch (e) {
    log({ runId: req.runId, model: req.model, status: 502, tokens: 0, costUsd: null });
    return Response.json({
      type: 'error',
      error: {
        type: 'api_error',
        message: `upstream unreachable: ${e instanceof Error ? e.message : 'unknown error'}`,
        code: 'upstream_unreachable',
      },
    }, { status: 502 });
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  const isStream = upstream.ok && contentType.includes('text/event-stream') && req.stream && upstream.body;

  if (!isStream) {
    // An upstream error, or a non-streaming body: pass it through as-is. A non-2xx carries no usage,
    // so it leaves no usage row (a call that did not complete is not a call we metered).
    const text = await upstream.text();
    if (!upstream.ok) {
      log({ runId: req.runId, model: req.model, status: upstream.status, tokens: 0, costUsd: null });
      return new Response(text, {
        status: upstream.status,
        headers: { 'content-type': contentType || 'application/json' },
      });
    }
    const parsed = safeJson(text) as {
      model?: unknown; usage?: never; stop_reason?: unknown;
    } | null;
    const meter = new StreamMeter({
      model: typeof parsed?.model === 'string' && parsed.model ? parsed.model : req.model,
      budgetUsd: verdict.budgetUsd,
      accruedUsd: verdict.accruedUsd,
    });
    meter.observe({ type: 'message_start', message: { model: parsed?.model, usage: parsed?.usage } });
    meter.observe({
      type: 'message_delta', usage: parsed?.usage, delta: { stop_reason: parsed?.stop_reason },
    });
    const counts = meter.snapshot();
    const costUsd = meter.pricedCost();
    await recordUsage({
      runId: req.runId, model: meter.pricedModel, counts, costUsd,
      stopReason: meter.stopReason, httpStatus: upstream.status,
    });
    log({ runId: req.runId, model: meter.pricedModel, status: upstream.status, tokens: totalTokens(counts), costUsd });
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': contentType || 'application/json' },
    });
  }

  // Step 5 — stream it through, metering as it goes.
  const meter = new StreamMeter({
    model: req.model,
    budgetUsd: verdict.budgetUsd,
    accruedUsd: verdict.accruedUsd,
  });
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let finished = false;

  /** Write the usage row and the log line exactly once, whatever ended the exchange. */
  const finalize = async (status: number, counts: UsageCounts, costUsd: number | null): Promise<void> => {
    if (finished) return;
    finished = true;
    await recordUsage({
      runId: req.runId, model: meter.pricedModel, counts, costUsd,
      stopReason: meter.stopReason, httpStatus: upstream.status,
    });
    log({ runId: req.runId, model: meter.pricedModel, status, tokens: totalTokens(counts), costUsd });
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // `null` is the upstream dying mid-stream: record what was metered and close cleanly.
      const chunk = await reader.read().catch(() => null);
      if (chunk === null) {
        await finalize(502, meter.snapshot(), meter.pricedCost());
        controller.close();
        return;
      }
      if (chunk.done) {
        await finalize(upstream.status, meter.snapshot(), meter.pricedCost());
        controller.close();
        return;
      }
      // The harness's bytes, untouched. Metering reads a decoded copy, never this one.
      controller.enqueue(chunk.value);

      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = safeJson(trimmed.slice(5).trim());
        if (!payload) continue;
        const observation = meter.observe(payload);
        if (observation === 'ok') continue;

        const crossed = observation === 'cap_crossed';
        const status = crossed ? 402 : 400;
        const bounded = meter.boundedSnapshot();
        const unpriced = meter.unpricedModel ?? meter.pricedModel;
        // Close the upstream first: nothing more is billed after the cap fires.
        abort.abort();
        await reader.cancel().catch(() => {});
        await refuseRun(verdict, {
          event: crossed ? 'budget_exceeded' : 'model_unpriced',
          model: crossed ? meter.pricedModel : unpriced,
          detail: crossed
            ? { budgetUsd: verdict.budgetUsd, accruedUsd: verdict.accruedUsd, midStream: true }
            : { model: unpriced, midStream: true },
          counts: bounded.counts,
          costUsd: crossed ? bounded.costUsd : null,
        }, status, log);
        finished = true; // refuseRun wrote the row; the flush must not write a second one.
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: {
            type: crossed ? 'budget_exceeded' : 'invalid_request_error',
            message: crossed
              ? `run ${req.runId} crossed its $${verdict.budgetUsd} budget mid-stream; the run is ended`
              : `model ${unpriced} is absent from MODEL_PRICING`,
          },
        })}\n\n`));
        controller.close();
        return;
      }
    },
    async cancel() {
      abort.abort();
      await reader.cancel().catch(() => {});
    },
  });

  return new Response(body, {
    status: upstream.status,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
    },
  });
}

function safeJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
