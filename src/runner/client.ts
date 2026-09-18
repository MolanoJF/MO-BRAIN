/**
 * The runner's ONLY door to the control plane (D1): HTTP with the
 * `RUNNER_TOKEN` bearer. This process holds no `CONTROL_DATABASE_URL`, no brain
 * DB URL, no `GBRAIN_HOME`, no `OPS_RPC_TOKEN` and no provider key, because it
 * is the one container in the stack that executes code an LLM chose — everything
 * it can reach, it can be talked into reaching.
 *
 * The vocabulary is the control plane's, imported as types only: `import type`
 * is erased, so the runner and `src/agent/claim.ts` cannot drift apart while the
 * runner still never loads the server's DB layer.
 *
 * Wire contract (Task 6, `src/control/routes/runs.ts`), all JSON, all under
 * `/api/runs`, all `Authorization: Bearer <RUNNER_TOKEN>`:
 *
 *   POST /claim            {runnerId, harnessVersion} -> 200 AgentRunClaim
 *                                                      | 204 long-poll timeout
 *                                                      | 400/409 refusal
 *   POST /:id/heartbeat    {runnerId}                 -> 200 | 409 lease_lost
 *   POST /:id/events       {events}                   -> 200 {inserted, replayed}
 *   POST /:id/finish       {runnerId, exitCode, …}    -> 200 | 409
 *
 * `204` is not an error — it is D3's "no work for the last 25 seconds", and the
 * loop continues immediately. Unset/empty `RUNNER_TOKEN` is answered **503
 * `runner_disabled`** by the control plane before any comparison; a wrong token
 * is `401`. Neither is retryable, so both are raised as `ControlFatalError` and
 * the process exits non-zero rather than spinning against a door that will not
 * open (D12's honest-signal rule).
 */
import type { AgentRunClaim, AgentRunEvent } from '../agent/types.ts';
import type {
  AgentClaimOutcome, AgentClaimRefusal, AgentFinishFacts, AgentFinishOutcome,
  AgentHeartbeatResult, RecordEventsOutcome,
} from '../agent/claim.ts';

/**
 * The control plane's own address on `runner-net` (D6). Compose sets
 * `CONTROL_URL`; the default matches the service name so a hand-run container
 * lands in the same place.
 */
const DEFAULT_CONTROL_URL = 'http://control-plane:3150';

/**
 * D3's long poll is `RUN_CLAIM_WAIT_MS` (Task 6, default 25000, deliberately
 * under the common 30s proxy idle timeout). The number is repeated here rather
 * than imported: that constant lives in a module that opens the control DB, and
 * the runner must not load it. Only the runner's own HTTP ceiling depends on it,
 * so a deployment that retunes the server's wait can leave this generous.
 */
const CLAIM_WAIT_MS = Number(process.env.RUN_CLAIM_WAIT_MS ?? 25_000);
const CLAIM_SLACK_MS = 15_000;

const HEARTBEAT_TIMEOUT_MS = 15_000;
const EVENTS_TIMEOUT_MS = 30_000;
/** Finish commits the run's writes, captures heads, computes the diff and
 *  revokes the gbrain token; the ops calls inside it are the slow part. */
const FINISH_TIMEOUT_MS = 180_000;

/** A refusal the runner must not retry: the door is shut, not busy. */
export class ControlFatalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ControlFatalError';
  }
}

type PostResult = { status: number; body: unknown };

/**
 * One POST, with a timeout the caller sizes, returning the status instead of
 * throwing on it: the routes' 4xx bodies are part of the contract (each refusal
 * has its own code), so they are values here, not exceptions.
 *
 * No request body is ever logged (S3c): the claim is the one place a secret
 * crosses to this process, and the frame batches carry brain content.
 */
async function post(
  url: string,
  token: string,
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PostResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: 'unparseable_response', detail: text.slice(0, 200) };
    }
  }
  return { status: res.status, body: parsed };
}

/** The server's own refusal code, or a status-shaped fallback. */
function codeOf(body: unknown, fallback: string): string {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'string' && error !== '' ? error : fallback;
}

function detailOf(body: unknown, status: number): string {
  const body_ = body as { detail?: unknown; error?: unknown } | null;
  const detail = typeof body_?.detail === 'string' ? body_.detail : null;
  return detail ?? codeOf(body, `control plane answered ${status}`);
}

/**
 * A 401 or a 503 `runner_disabled` is a deployment that cannot work: the
 * control plane's `RUNNER_TOKEN` and this process's are the same variable, so
 * there is nothing to retry and nothing to wait for.
 */
function assertNotFatal(status: number, body: unknown): void {
  if (status === 401 || status === 403) {
    throw new ControlFatalError(status, codeOf(body, 'unauthorized'),
      `the control plane rejected RUNNER_TOKEN (${status})`);
  }
  if (status === 503) {
    const code = codeOf(body, 'unavailable');
    throw new ControlFatalError(status, code,
      `the control plane is not accepting runs: ${code} (${detailOf(body, status)})`);
  }
}

export type ControlClient = {
  /** D3: long-polls; `204` becomes `{status:'none'}` and the loop continues. */
  claim(args: {
    runnerId: string;
    harnessVersion: string;
    signal?: AbortSignal;
  }): Promise<AgentClaimOutcome>;
  heartbeat(runId: string, runnerId: string): Promise<AgentHeartbeatResult>;
  events(runId: string, events: readonly AgentRunEvent[]): Promise<RecordEventsOutcome>;
  finish(facts: Omit<AgentFinishFacts, 'nowMs'>): Promise<AgentFinishOutcome>;
};

export function createControlClient(opts: {
  url?: string;
  token?: string;
} = {}): ControlClient {
  const url = (opts.url ?? process.env.CONTROL_URL ?? DEFAULT_CONTROL_URL).replace(/\/+$/, '');
  const token = opts.token ?? process.env.RUNNER_TOKEN ?? '';

  return {
    async claim({ runnerId, harnessVersion, signal }) {
      const res = await post(
        url, token, '/api/runs/claim', { runnerId, harnessVersion },
        CLAIM_WAIT_MS + CLAIM_SLACK_MS, signal,
      );
      assertNotFatal(res.status, res.body);
      // D3: an empty long poll is not an error. It is the expected answer most
      // of the time, and the loop goes straight back round.
      if (res.status === 204) return { status: 'none' };
      if (res.status === 200) return { status: 'claimed', claim: res.body as AgentRunClaim };
      // 400 (request shape) and 409 (a run was consumed as refused) both carry a
      // refusal code; the caller backs off rather than hot-looping.
      const refusal = (res.body ?? {}) as Record<string, unknown>;
      return {
        status: 'refused',
        refusal: {
          ...refusal,
          error: codeOf(res.body, 'claim_refused'),
          detail: detailOf(res.body, res.status),
        } as unknown as AgentClaimRefusal,
      };
    },

    async heartbeat(runId, runnerId) {
      const res = await post(
        url, token, `/api/runs/${runId}/heartbeat`, { runnerId }, HEARTBEAT_TIMEOUT_MS,
      );
      assertNotFatal(res.status, res.body);
      if (res.status === 200) return res.body as AgentHeartbeatResult;
      // 409 is the lease being gone (stolen or cancelled) and 404 is a run that
      // no longer exists; the caller stops the run either way.
      const code = codeOf(res.body, res.status === 404 ? 'run_unknown' : 'lease_lost');
      const error: 'run_unknown' | 'lease_lost' | 'cancel_requested' =
        code === 'run_unknown' ? 'run_unknown'
          : code === 'cancel_requested' ? 'cancel_requested' : 'lease_lost';
      return { error, runId, detail: detailOf(res.body, res.status) };
    },

    async events(runId, events) {
      const res = await post(url, token, `/api/runs/${runId}/events`, { events }, EVENTS_TIMEOUT_MS);
      assertNotFatal(res.status, res.body);
      if (res.status === 200) return res.body as RecordEventsOutcome;
      return { error: 'invalid_event', detail: detailOf(res.body, res.status) };
    },

    async finish(facts) {
      const { runId, ...body } = facts;
      const res = await post(url, token, `/api/runs/${runId}/finish`, body, FINISH_TIMEOUT_MS);
      assertNotFatal(res.status, res.body);
      if (res.status === 200) return res.body as AgentFinishOutcome;
      const code = codeOf(res.body, 'run_not_finished');
      const error: 'run_unknown' | 'run_not_finished' | 'lease_lost' =
        code === 'run_unknown' ? 'run_unknown'
          : code === 'lease_lost' ? 'lease_lost' : 'run_not_finished';
      return { error, runId, detail: detailOf(res.body, res.status) };
    },
  };
}
