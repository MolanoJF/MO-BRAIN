/**
 * D9 — the brain diff. Read-only. Ops holds the repos (S2), so the only door
 * out of here is ops' `/git/range`; nothing in this module reads a repo, writes
 * a repo, or writes an alert.
 */
import { gitRange } from '../control/opsClient.ts';
import type { GitRange, RangeCommit } from '../ops/git.ts';
import type { CommitAttribution, DiffSummary, ReadSpaceMove, SpaceDiff, SpaceHeads } from './types.ts';

/**
 * The ops `/git/range` boundary. Injectable so the composition below is unit
 * testable without a server; the default is the real ops client.
 */
export type RangeFetcher = (sourceId: string, before: string, after: string) => Promise<GitRange>;

const HEAD = 'HEAD';

/**
 * Capture `git rev-parse HEAD` for every Space the caller names — the write
 * Space plus every read Space (D9). Runs at claim and again at finish; the pair
 * serializes into `agent_runs.heads_before` / `heads_after`.
 *
 * The degenerate `HEAD..HEAD` range is the probe: one verb serves both the head
 * read and the range read, and a head we cannot resolve throws instead of
 * quietly becoming a missing map entry. Sequential because each call takes that
 * repo's advisory lock on a reserved pooled connection.
 */
export async function captureHeads(
  spaces: string[],
  fetchRange: RangeFetcher = gitRange,
): Promise<SpaceHeads> {
  const heads: SpaceHeads = {};
  for (const space of spaces) {
    heads[space] = (await fetchRange(space, HEAD, HEAD)).after;
  }
  return heads;
}

/**
 * Attribute a range to the run's member (honesty rule 6). A commit whose author
 * email is not the member's is a concurrent writer: counted, named, and listed.
 */
export function attributeCommits(
  commits: RangeCommit[],
  member: { name: string; email: string },
): CommitAttribution {
  const mine = member.email.trim().toLowerCase();
  const foreign = commits.filter((c) => c.email.trim().toLowerCase() !== mine);
  return {
    concurrentWriters: foreign.length > 0,
    foreignCommitCount: foreign.length,
    foreignAuthors: [...new Set(foreign.map((c) => `${c.author} <${c.email}>`))],
  };
}

/**
 * Build the run's `DiffSummary` from the two head maps.
 *
 * Per Space the write range is `git log` + `git diff --name-status`. A read
 * Space whose head moved is reported as a `ReadSpaceMove` for the caller to
 * alert on (`agent_read_space_moved`) — it is never fetched and never becomes a
 * diff row (honesty rule 10).
 *
 * An uncaptured head throws: that is a caller bug, and an empty diff would be a
 * silent pass.
 */
export async function diffForRun(args: {
  writeSpace: string;
  readSpaces: string[];
  before: SpaceHeads;
  after: SpaceHeads;
  member: { name: string; email: string };
  fetchRange?: RangeFetcher;
}): Promise<DiffSummary> {
  const fetchRange = args.fetchRange ?? gitRange;

  const head = (map: SpaceHeads, space: string): string => {
    const sha = map[space];
    if (!sha) {
      throw new Error(`no captured head for Space ${space}: captureHeads must run before diffForRun`);
    }
    return sha;
  };

  const before = head(args.before, args.writeSpace);
  const after = head(args.after, args.writeSpace);

  // Identical heads are positive evidence of an unchanged range: no git call.
  const range: Pick<GitRange, 'commits' | 'files'> = before === after
    ? { commits: [], files: [] }
    : await fetchRange(args.writeSpace, before, after);

  const write: SpaceDiff = {
    sourceId: args.writeSpace,
    before,
    after,
    commits: range.commits,
    files: range.files,
    ...attributeCommits(range.commits, args.member),
  };

  const readSpaceMoves: ReadSpaceMove[] = args.readSpaces
    .filter((space) => head(args.before, space) !== head(args.after, space))
    .map((space) => ({ sourceId: space, before: head(args.before, space), after: head(args.after, space) }));

  return { write, readSpaceMoves, concurrentWriters: write.concurrentWriters };
}
