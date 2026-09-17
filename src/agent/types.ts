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
