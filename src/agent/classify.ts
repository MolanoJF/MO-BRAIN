/**
 * D11 — retries are classified, and the default is not to retry.
 *
 * **This is a second mapper on purpose, not a widened `Classification`.**
 * `src/scheduler/execute.ts`'s union is total over its `SEVERITY` map and
 * `worst()` indexes the two against each other for Slice 3's "worse of the two
 * steps" ordering; adding agent vocabulary to it would silently change that
 * ordering. So `classifyAgentExit` READS `classifyExit`'s exit-code table
 * (L8: 0 = ok, 4 = `LOCK_LOST`, 143 = 128+SIGTERM = our own timeout) and
 * returns a `FailureClass` instead. `src/scheduler/execute.ts` is untouched.
 *
 * **Honesty rule 1 is why this takes facts, not a process result.** A harness
 * that reported success is not a successful run: the receipt is the event
 * stream plus the git range, so a run with error frames — or a non-zero exit —
 * is failed *regardless of what its final assistant message says*. That is why
 * `finalMessage` is carried in the input and deliberately never read: the
 * agent's own self-assessment is evidence, not a status, in either direction.
 *
 * **L14 is why a recorded class wins.** The failure class lives on the row.
 * When a component already recorded one — D7's meter writes `budget_exceeded`
 * or `refused` before the harness is reaped, the claim path writes `refused`
 * before a run is ever minted — that class is returned unchanged, because it was
 * written by the component that witnessed the cause and the exit code is only
 * its symptom. Without this the finish path would relabel a meter-enforced cap
 * as "the agent failed" the moment the harness died with a non-zero status, and
 * the operator would be told the wrong story about their money.
 *
 * Nothing here starts a run, writes a row or raises an alert. Task 6 creates the
 * retry row (`attempt = n+1`, slot `<slot>#r<n+1>`, so the UNIQUE
 * `(schedule_id, slot)` key still holds and the failed attempt stays in
 * history) from `retryPolicyFor`'s decision; `src/agent/alerts.ts` is the one
 * place an agent alert is written.
 */
import { classifyExit } from '../scheduler/execute.ts';
import type { FailureClass } from './types.ts';

/**
 * An agent run has no gbrain command — `schedules.operation` is NULL on an
 * `agent_prompt` row by the shape CHECK (Task 4) — and `classifyExit` branches
 * on exactly one id, `sources-push`. This constant is the job type, and it is
 * passed as the command id on purpose: it takes the generic branch, so we read
 * L8's numeric table (0/4/143) rather than keeping a second copy of it here.
 */
const AGENT_JOB_TYPE = 'agent_prompt';

/**
 * Everything the finish path knows once the harness is gone. Every field except
 * `exitCode` is optional so a run that died before the stream existed is still
 * classifiable.
 */
export type AgentExitFacts = {
  /**
   * The harness process's exit code. `-1` is the runner's report that NO
   * process ever produced one — D11's "harness spawn failure", which is
   * infrastructure and retries.
   */
  exitCode: number;
  /**
   * How many frames in the recorded stream reported an error: the `result`
   * frame's own `is_error: true`, the harness's `api_retry` frames, a
   * tool result that came back `isError`. One is a failure (honesty rule 1) —
   * the stream is the receipt.
   */
  errorFrames?: number;
  /**
   * The class already on the row, when a component recorded one (`agent_runs.
   * failure_class`). It WINS over the exit code (L14): see the module comment.
   */
  recorded?: FailureClass | null;
  /**
   * The last assistant or `result` text. Carried for the audit trail and NEVER
   * read: rendering the agent's self-assessment as the run's status is the
   * trust bug honesty rule 1 names.
   */
  finalMessage?: string | null;
};

/**
 * The exit code, through L8's table — one vocabulary, not two.
 *
 *  - **No code at all** (`< 0`) → `infra_failed`. `-1` is not an exit code; it
 *    is the runner's report that it could not spawn the harness, which D11's
 *    `infra_failed` row names outright ("harness spawn failure"). L8's table is
 *    read only for real codes, so this is decided before the switch.
 *  - `ok` (exit 0) → no failure class; the stream still gets a say below.
 *  - `timeout` (exit 143) → `timeout`. Our SIGTERM killed it; D11 never retries
 *    a run that overran once.
 *  - `lock_lost` (exit 4) → `infra_failed`. "Someone else owns this now" is
 *    ownership, not an agent mistake — D11's `infra_failed` row is "lease lost,
 *    runner OOM/killed, gateway network error, harness spawn failure", and
 *    honesty rule 5 already classifies a lost lease there.
 *  - anything else → `agent_failed`. D11's row is unconditional: "harness exited
 *    non-zero, or the stream carried error frames". The `sources-push` branches
 *    (blocked/conflict/refused on exits 5 and 1) are unreachable from here —
 *    an agent run is not a push — so they fall to `agent_failed` too.
 */
function classForExitCode(exitCode: number): FailureClass | null {
  if (exitCode < 0) return 'infra_failed';
  switch (classifyExit(AGENT_JOB_TYPE, exitCode, null)) {
    case 'ok':
      return null;
    case 'timeout':
      return 'timeout';
    case 'lock_lost':
      return 'infra_failed';
    default:
      return 'agent_failed';
  }
}

/**
 * D11's classification for one finished agent run. `null` means the run
 * succeeded, and `null` is the only value `retryPolicyFor` treats as "nothing
 * failed".
 */
export function classifyAgentExit(facts: AgentExitFacts): FailureClass | null {
  // L14: a component that witnessed the cause has already answered. Never
  // re-derive, never overwrite.
  const recorded = facts.recorded ?? null;
  if (recorded) return recorded;

  const fromExit = classForExitCode(facts.exitCode);
  if (fromExit) return fromExit;

  // The harness exited 0, so D11's second condition decides: a stream that
  // carried error frames is a failed run, whatever the last message said.
  return (facts.errorFrames ?? 0) > 0 ? 'agent_failed' : null;
}

/**
 * D11's decision, and the sentence that explains it (L14: it is stored on the
 * row so no renderer reconstructs it).
 */
export type RetryDecision = {
  /** True when Task 6 may insert a new `schedule_runs` row for this failure. */
  retry: boolean;
  /**
   * The attempt number that retry row carries (`attempt = n+1`, D11). `null`
   * whenever `retry` is false — there is no next attempt to name.
   */
  nextAttempt: number | null;
  /**
   * D11's cap: how many retries a class permits, i.e. attempts beyond the
   * first. `0` for a class that never retries, so the caller never has to know
   * which classes have a cap.
   */
  cap: number;
  /** Operator-facing prose. Never an enum name: this is rendered, not parsed. */
  reason: string;
};

/** D11's one retryable class, and its one number. */
const INFRA_RETRY_CAP = 2;

/** Every class with no retry clause. `infra_failed` is not one of them. */
type RetrylessClass = Exclude<FailureClass, 'infra_failed'>;

const NEVER_RETRIES: Record<RetrylessClass, string> = {
  budget_exceeded:
    'The budget cap was reached, so the run was stopped while it still had '
    + 'money to spend. Retrying would spend more against a cap this run already '
    + 'crossed.',
  timeout:
    'The run exceeded its timeout and was killed. Retrying would redo work that '
    + 'already overran once.',
  agent_failed:
    'The harness failed this run: it exited non-zero, or its stream carried '
    + 'error frames. Retrying would ask the same agent the same question again.',
  refused:
    'The run never started: there is no active Connection, no runner has been '
    + 'seen, or the harness version does not match the pin. A retry cannot fix '
    + 'a precondition.',
};

/**
 * D11's table, implemented once.
 *
 * | class | policy |
 * |---|---|
 * | `infra_failed` | retry, cap 2 |
 * | `budget_exceeded` / `timeout` / `agent_failed` / `refused` | never |
 *
 * `attempt` is 1-based and is `schedule_runs.attempt`, whose column default is
 * 1: retry is allowed while the FAILED attempt is within the cap, so a cap of 2
 * means attempts 1, 2 and 3 exist and a third failure is the last. An attempt
 * the caller cannot state fails closed (no retry) — the safe direction for a cap
 * on a non-idempotent run.
 */
export function retryPolicyFor(failureClass: FailureClass | null, attempt: number): RetryDecision {
  if (failureClass === 'infra_failed') {
    const next = attempt + 1;
    return attempt <= INFRA_RETRY_CAP
      ? {
        retry: true,
        nextAttempt: next,
        cap: INFRA_RETRY_CAP,
        reason: `Interrupted by infrastructure rather than by the agent `
          + `(attempt ${attempt} of at most ${INFRA_RETRY_CAP + 1}): retrying as `
          + `attempt ${next}.`,
      }
      : {
        retry: false,
        nextAttempt: null,
        cap: INFRA_RETRY_CAP,
        reason: `Interrupted by infrastructure again on attempt ${attempt}, and `
          + `the cap of ${INFRA_RETRY_CAP} retries is spent. This run stops here.`,
      };
  }

  if (failureClass === null) {
    return {
      retry: false,
      nextAttempt: null,
      cap: 0,
      reason: 'The run succeeded, so there is nothing to retry.',
    };
  }

  return {
    retry: false,
    nextAttempt: null,
    cap: 0,
    reason: NEVER_RETRIES[failureClass],
  };
}
