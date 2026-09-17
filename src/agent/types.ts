/**
 * Slice 4 agent-runner types. Additive by design: `AgentRunSpec`,
 * `AgentRunClaim`, `AgentRunEvent` and `FailureClass` land in this same file.
 */
import type { RangeCommit, RangeFile } from '../ops/git.ts';

export type { RangeCommit, RangeFile };

/**
 * Space id -> the commit HEAD pointed at when the head was captured (D9).
 * The caller supplies the Space list — the write Space plus every read Space —
 * because ops holds the repo plane while the Connection's compiled
 * `federatedRead` is control-plane knowledge. Serializes straight into
 * `agent_runs.heads_before` / `heads_after`.
 */
export type SpaceHeads = Record<string, string>;

/**
 * How much of a range we can honestly attribute (honesty rule 6). gbrain commits
 * its own writes inside upstream code (G3, `src/ops/git.ts`), so foreign commits
 * in the range are expected — they are reported, never assumed away.
 */
export type CommitAttribution = {
  concurrentWriters: boolean;
  /** How many commits in the range were not authored by the run's member. */
  foreignCommitCount: number;
  /** Every distinct foreign author as `Name <email>`, in range order. */
  foreignAuthors: string[];
};

/** The write Space's range: the agent's work, attributed as far as the contracts allow. */
export type SpaceDiff = {
  sourceId: string;
  before: string;
  after: string;
  commits: RangeCommit[];
  files: RangeFile[];
} & CommitAttribution;

/**
 * A read Space whose HEAD moved during the run. Read isolation is the Slice 2
 * promise, so this is an alert — never a diff row (honesty rule 10). The finish
 * path raises alert kind `agent_read_space_moved` from it; this module writes no alerts.
 */
export type ReadSpaceMove = {
  sourceId: string;
  before: string;
  after: string;
};

export type DiffSummary = {
  write: SpaceDiff;
  /** Empty is the expected, healthy case. */
  readSpaceMoves: ReadSpaceMove[];
  /** Mirrors `write.concurrentWriters` — D9's name for the console's hedge. */
  concurrentWriters: boolean;
};

/**
 * D11's failure vocabulary, and the five values the CHECK
 * `agent_failure_class_valid` on `agent_runs.failure_class` permits (Task 4).
 * The two are the same list on purpose: `classifyAgentExit` returns this type,
 * the column stores it verbatim, and a renderer reads it rather than
 * reconstructing it (L14 — Slice 3's mistake).
 *
 * `null` is a SUCCESS, not a sixth class: the column is nullable because a
 * failure class is a diagnosis, and a run that did not fail has none. `null`
 * has no SQL spelling in the CHECK above, so `is null` is the whole of it.
 */
export type FailureClass =
  | 'budget_exceeded'
  | 'agent_failed'
  | 'infra_failed'
  | 'timeout'
  | 'refused';

// --- Dispatch (Task 6) -------------------------------------------------------

/**
 * The schedule's agent payload plus the Connection facts a claim needs — the
 * run's SPEC, resolved once at claim time. Money stays a string, exactly as
 * `schedules.agent_budget_usd` and `agent_runs.budget_usd` store it: a float
 * round-trip through JSON is the one way a cap can move.
 *
 * `readSpaces` is the Space SOURCE ids (not the control-plane Space ids):
 * `captureHeads` and `diffForRun` speak the repo plane, which knows sources.
 */
export type AgentRunSpec = {
  scheduleId: string;
  /** `schedule_runs.attempt`. A retry is a NEW row with `attempt = n + 1`. */
  attempt: number;
  organizationId: string;
  connectionId: string;
  /** The member the range is attributed against and the commit is signed by. */
  member: { name: string; email: string };
  writeSpace: string;
  readSpaces: string[];
  prompt: string;
  model: string;
  maxTokens: number;
  budgetUsd: string;
  harnessVersion: string;
  timeoutSeconds: number;
};

/**
 * D3 — the claim response: everything the run needs and nothing it does not.
 *
 * This is the ONLY place a secret crosses to the runner (D3), it crosses over
 * the internal network, and both tokens die with the run: `mcp.token` is the
 * per-run gbrain credential, revoked by `revokeRunToken` on every exit path
 * (D8), and `gateway.token` is the stateless HMAC whose "burned at run end" is
 * the `agent_runs` lookup the budget check already performs (D7). Neither ever
 * appears in a projection a human can read.
 */
export type AgentRunClaim = {
  runId: string;
  scheduleId: string;
  attempt: number;
  prompt: string;
  model: string;
  maxTokens: number;
  /** The schedule's pin. The runner refuses the claim unless its own
   *  `claude --version` reports exactly this (D4). */
  harnessVersion: string;
  /** Already intersected and fully qualified: `mcp__gbrain__<tool>` (D5). */
  allowedTools: string[];
  mcp: { url: string; token: string };
  gateway: { url: string; token: string };
  budgetUsd: number;
  timeoutSeconds: number;
  leaseExpiresAt: string;
};

/**
 * One normalized harness frame as appended to `agent_run_events`. `seq` is the
 * runner's own monotonic counter; the UNIQUE `(run_id, seq)` key is what makes
 * a replayed batch idempotent rather than duplicating. `data` is the REDACTED
 * frame — tool arguments and brain content never land here raw (S3c).
 */
export type AgentRunEvent = {
  seq: number;
  kind: string;
  data?: unknown;
};
