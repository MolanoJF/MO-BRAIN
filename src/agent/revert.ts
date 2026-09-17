/**
 * D10 — revert is a new commit plus a re-index, never a history rewrite.
 *
 * `revertRun` is what Task 6's admin-only `POST /api/runs/:id/revert` calls:
 *
 *   1. `git revert --no-commit <before>..<after>` in the write Space and the
 *      commit that signs it — ONE locked sequence in ops (`git.ts`'s
 *      `revertRange`), signed by the acting admin with the run id in the message,
 *      because the audit story is a named human, not "the system";
 *   2. `agent_runs.reverted_at` + `revert_commit`, written the moment the commit
 *      exists;
 *   3. `sync` + `embed --stale` through the normal scheduler command path, so the
 *      brain's index moves back with the tree.
 *
 * Nothing here auto-reverts, ever. Honesty rule 7 is why a failed step 3 THROWS
 * instead of returning the success shape: the git commit is real and the row
 * records it, but a reverted file that still answers searches is not reverted,
 * and the caller must not be able to render it as one.
 *
 * The three refusals are RETURNED, never thrown, so a route maps each one
 * straight to a status and a body without re-deriving anything. Every one carries
 * a `detail` with the facts behind it, and the concurrent-writer case names the
 * authors (honesty rule 6). Unknown runs and ops failures throw — those are not
 * choices the console can offer.
 *
 * P8 makes one refusal the NORMAL case: an MCP write lands in the database and
 * the file plane, not in git, so a run whose finish path did not commit carries
 * an empty recorded range. That is `already_reverted` with
 * `reason: 'empty_range'` — never a forced revert of nothing.
 */
import { eq } from 'drizzle-orm';
import { buildArgv, redactArgv } from '../contracts/argv.ts';
import { OPERATIONS } from '../contracts/registry.ts';
import { getDb, schema } from '../control/db/client.ts';
import { callOps, gitRange, gitRevertRange } from '../control/opsClient.ts';
import type { RangeFile, RevertOutcome, RevertRequest } from '../ops/git.ts';
import { SCHEDULER_COMMANDS, fenceParams, validateParams, type SchedulerCommand } from '../scheduler/commands.ts';
import { classifyExit, type Classification } from '../scheduler/execute.ts';
import { attributeCommits, type RangeFetcher } from './diff.ts';

/**
 * What `revertRun` knows about the run: the write Space, the member the range is
 * attributed against (honesty rule 6), and the head pair captured at claim and at
 * finish (D9).
 */
export type RevertTarget = {
  runId: string;
  /** null when the Connection is gone — `agent_runs.connection_id` is `set null`. */
  sourceId: string | null;
  member: { name: string; email: string } | null;
  /** null until the run finished: heads_after is written by the finish path. */
  before: string | null;
  after: string | null;
  revertedAt: Date | null;
  revertCommit: string | null;
};

/**
 * One indexing step's receipt: the argv the scheduler path built, what it exited
 * with, and how `classifyExit` read it — L8's vocabulary, not a second one.
 */
export type IndexStep = {
  argv: string[];
  exitCode: number;
  stderr: string;
  classification: Classification;
};

export type RevertSuccess = {
  reverted: true;
  runId: string;
  sourceId: string;
  /** The NEW commit, on top of history — `agent_runs.revert_commit`. */
  revertCommit: string;
  revertedAt: string;
  /** The inverse diff, as `git diff --cached --name-status` saw it. */
  files: RangeFile[];
  /** Both steps, always: a re-index that did not complete throws instead. */
  index: { sync: IndexStep; embed: IndexStep };
};

/** D10's refusals, each an explicit `{ error, …context }` the console renders as
 *  a choice. */
export type RevertRefusal =
  | {
    error: 'already_reverted';
    runId: string;
    /**
     * WHICH already-reverted this is, because P8 made them all normal cases:
     * `recorded` — the row carries a revert; `empty_range` — the run's recorded
     * range holds no commits (its work never reached git, e.g. an untracked
     * write); `nothing_to_revert` — git found an empty inverse diff.
     */
    reason: 'recorded' | 'empty_range' | 'nothing_to_revert';
    /** The stamp we found, or null when git reported nothing left to undo. */
    revertedAt: string | null;
    revertCommit: string | null;
    detail: string;
  }
  | {
    error: 'revert_conflict';
    runId: string;
    /** null when the Connection is gone and no Space can be named. */
    sourceId: string | null;
    detail: string;
  }
  | {
    error: 'revert_concurrent_writers';
    runId: string;
    sourceId: string;
    /** Commits in the recorded range, so the console can say "2 of 5". */
    commitCount: number;
    foreignCommitCount: number;
    /** `Name <email>`, in range order — D9's shape, not a second convention. */
    foreignAuthors: string[];
    detail: string;
  };

export type RevertResult = RevertSuccess | RevertRefusal;

/**
 * Everything `revertRun` reaches outside itself, injectable for the same reason
 * `diff.ts` injects its range fetcher: which refusal a given run earns is worth
 * proving without a database and a repo behind it.
 */
export type RevertDeps = {
  loadTarget: (runId: string) => Promise<RevertTarget | null>;
  markReverted: (runId: string, at: Date, sha: string) => Promise<void>;
  fetchRange: RangeFetcher;
  revertRange: (req: RevertRequest) => Promise<RevertOutcome>;
  callOps: typeof callOps;
  now: () => number;
};

/** How long each re-index step may take. Named rather than inherited from a
 *  client default: a human is sitting behind this request. */
const INDEX_TIMEOUT_MS = 600_000;

export async function revertRun(
  args: { runId: string; actor: { name: string; email: string }; confirm?: 'concurrent' },
  deps: RevertDeps = defaultDeps,
): Promise<RevertResult> {
  const { runId, actor, confirm } = args;

  const target = await deps.loadTarget(runId);
  // An unknown run is a caller bug, not a refusal code: Task 6's route 404s.
  if (!target) throw new Error(`agent run ${runId} not found`);

  if (target.revertedAt) {
    return {
      error: 'already_reverted',
      runId,
      reason: 'recorded',
      revertedAt: target.revertedAt.toISOString(),
      revertCommit: target.revertCommit,
      detail: `run ${runId} was already reverted by commit ${target.revertCommit ?? 'an unrecorded commit'}`,
    };
  }

  const { sourceId, member, before, after } = target;
  if (!sourceId || !member || !before || !after) {
    return {
      error: 'revert_conflict',
      runId,
      sourceId,
      detail: !sourceId || !member
        ? `run ${runId} has no resolvable write Space: its Connection is gone, so nothing can be honestly reverted`
        : `run ${runId} has no recorded head range for ${sourceId}: heads are captured at claim and at finish, `
          + 'so a run that never finished — or never wrote — cannot be reverted',
    };
  }

  // The range is read LIVE, not from the stored summary: this is the range about
  // to be inverted, and honesty rule 6 wants its authors as they are now.
  const range = await deps.fetchRange(sourceId, before, after);
  const span = `${before.slice(0, 7)}..${after.slice(0, 7)}`;
  if (range.commits.length === 0) {
    return {
      error: 'already_reverted',
      runId,
      reason: 'empty_range',
      revertedAt: null,
      revertCommit: null,
      // P8: an MCP write lands as an untracked file, so an empty range is the
      // NORMAL case, not an exotic one. Say which it is rather than claiming a
      // revert: nothing in git moved for this run.
      detail: `the recorded range ${span} in ${sourceId} is empty: run ${runId} never committed anything `
        + 'there, so there is nothing to revert',
    };
  }

  const attribution = attributeCommits(range.commits, member);
  if (attribution.concurrentWriters && confirm !== 'concurrent') {
    return {
      error: 'revert_concurrent_writers',
      runId,
      sourceId,
      commitCount: range.commits.length,
      foreignCommitCount: attribution.foreignCommitCount,
      foreignAuthors: attribution.foreignAuthors,
      detail: `${attribution.foreignCommitCount} of ${range.commits.length} commits in ${span} `
        + `were not written by ${member.email}: ${attribution.foreignAuthors.join(', ')}. `
        + "Reverting undoes their work too — confirm 'concurrent' to proceed.",
    };
  }

  const outcome = await deps.revertRange({
    sourceId, before, after, actor,
    message: `revert: agent run ${runId}`,
  });

  if (!outcome.reverted) {
    return outcome.reason === 'nothing_to_revert'
      ? {
        error: 'already_reverted',
        runId,
        reason: 'nothing_to_revert',
        revertedAt: null,
        revertCommit: null,
        detail: `the inverse diff of ${span} in ${sourceId} is empty: the range is already back, `
          + 'so there is nothing to commit',
      }
      : { error: 'revert_conflict', runId, sourceId, detail: outcome.detail };
  }

  // The git fact first: the commit is on the Space's history the moment it lands,
  // whether or not step 3 follows it.
  const at = new Date(deps.now());
  await deps.markReverted(runId, at, outcome.sha);

  const index = await reindex(sourceId, deps);
  const embed = index.embed;
  if (embed === null || index.sync.classification !== 'ok' || embed.classification !== 'ok') {
    const failing = embed ?? index.sync;
    throw new Error(
      `revert commit ${outcome.sha} landed for run ${runId} but the brain index did not move: `
      + `${failing.argv.join(' ')} exited ${failing.exitCode} (${failing.classification}) `
      + `${failing.stderr.trim()}. Honesty rule 7: a reverted file that still answers searches is not reverted.`,
    );
  }

  return {
    reverted: true,
    runId,
    sourceId,
    revertCommit: outcome.sha,
    revertedAt: at.toISOString(),
    files: outcome.files,
    index: { sync: index.sync, embed },
  };
}

/**
 * Step 3, through the NORMAL scheduler command path: the same
 * `SCHEDULER_COMMANDS` entries, the same Connection fence (`fenceParams` derives
 * `--source` from the write Space, so a caller cannot supply it), the same ops
 * RPC argv build. No shell, and never gbrain straight from the control plane (S2).
 *
 * The embed runs only when sync succeeded — the rule `live-sync`'s step 2 carries:
 * embedding a half-imported Space commits chunks of a state sync never reached.
 */
async function reindex(
  writeSourceId: string,
  deps: RevertDeps,
): Promise<{ sync: IndexStep; embed: IndexStep | null }> {
  const sync = SCHEDULER_COMMANDS['sync'];
  const embed = SCHEDULER_COMMANDS['embed'];
  if (!sync || !embed) throw new Error('the scheduler allowlist is missing sync or embed');

  const syncStep = await runIndexStep(
    sync, fenceParams(sync, validateParams(sync, {}), writeSourceId), deps,
  );
  if (syncStep.classification !== 'ok') return { sync: syncStep, embed: null };

  return {
    sync: syncStep,
    embed: await runIndexStep(
      embed, fenceParams(embed, validateParams(embed, { stale: true }), writeSourceId), deps,
    ),
  };
}

async function runIndexStep(
  command: SchedulerCommand,
  params: Record<string, string | boolean>,
  deps: RevertDeps,
): Promise<IndexStep> {
  const spec = OPERATIONS[command.operation];
  if (!spec) throw new Error(`scheduler command ${command.id} names an unknown operation ${command.operation}`);
  const argv = redactArgv(spec, ['gbrain', ...buildArgv(spec, params, { json: command.json })]);

  try {
    const r = await deps.callOps(command.operation, params, {
      json: command.json, timeoutMs: INDEX_TIMEOUT_MS,
    });
    return {
      argv, exitCode: r.exitCode, stderr: r.stderr,
      classification: classifyExit(command.id, r.exitCode, r.json),
    };
  } catch (e) {
    // The op never produced an exit code: -1 classifies as a plain failure, and
    // the thrown message is the only diagnosis there is (execute.ts's runStep
    // holds the same line).
    return {
      argv, exitCode: -1, stderr: e instanceof Error ? e.message : String(e),
      classification: classifyExit(command.id, -1, null),
    };
  }
}

/** One string value out of a jsonb head map, validated: an unreadable map entry
 *  is a missing head, and a missing head is a refusal rather than an empty diff. */
function headFor(heads: unknown, sourceId: string): string | null {
  if (!heads || typeof heads !== 'object') return null;
  for (const [key, value] of Object.entries(heads)) {
    if (key === sourceId && typeof value === 'string') return value;
  }
  return null;
}

/**
 * The run's write Space, member and head pair, read once. null means "no such
 * run", which the route answers with a 404. A deleted Connection leaves the Space
 * and the member null — the row outlives its Connection on purpose, and the
 * refusal says so rather than guessing a Space.
 */
async function loadTarget(runId: string): Promise<RevertTarget | null> {
  const db = getDb();
  const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.runId, runId));
  if (!row) return null;

  const bare: RevertTarget = {
    runId,
    sourceId: null,
    member: null,
    before: null,
    after: null,
    revertedAt: row.revertedAt,
    revertCommit: row.revertCommit,
  };
  if (!row.connectionId) return bare;

  const [connection] = await db.select().from(schema.connections)
    .where(eq(schema.connections.id, row.connectionId));
  if (!connection) return bare;

  const [space] = await db.select().from(schema.spaces)
    .where(eq(schema.spaces.id, connection.writeSpaceId));
  // The member's identity comes from membership -> user, never from a request
  // body — the same path the scheduler takes for a report commit.
  const [identity] = await db.select({ name: schema.users.name, email: schema.users.email })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.id, connection.membershipId));
  if (!space || !identity) return bare;

  return {
    ...bare,
    sourceId: space.sourceId,
    member: { name: identity.name ?? identity.email, email: identity.email },
    before: headFor(row.headsBefore, space.sourceId),
    after: headFor(row.headsAfter, space.sourceId),
  };
}

async function markReverted(runId: string, at: Date, sha: string): Promise<void> {
  await getDb().update(schema.agentRuns)
    .set({ revertedAt: at, revertCommit: sha })
    .where(eq(schema.agentRuns.runId, runId));
}

const defaultDeps: RevertDeps = {
  loadTarget,
  markReverted,
  fetchRange: gitRange,
  revertRange: gitRevertRange,
  callOps,
  now: () => Date.now(),
};
