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
 *   3. the index moves back with the tree: the pages the revert REMOVED are
 *      deleted by name (F15 — the scheduler's `sync` cannot do it, because a
 *      file whose addition and removal landed inside one unsynced delta nets to
 *      nothing), then `sync` + `embed --stale` through the normal scheduler
 *      command path.
 *
 * Nothing here auto-reverts, ever. Honesty rule 7 is why a failed step 3 THROWS
 * instead of returning the success shape: the git commit is real and the row
 * records it, but a reverted file that still answers searches is not reverted,
 * and the caller must not be able to render it as one. A purge the guard SKIPPED
 * is not a failure — a slug whose file is still in the tree is live work and
 * removing it would delete someone else's page — but it is recorded in the
 * result, so a git-only revert is visible as one.
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
import { pageDeleteNeedsForce } from '../contracts/pin.ts';
import { OPERATIONS } from '../contracts/registry.ts';
import { getDb, schema } from '../control/db/client.ts';
import { callOps, gitPathExists, gitRange, gitRevertRange } from '../control/opsClient.ts';
import type { RangeFile, RevertOutcome, RevertRequest, TreeProbe } from '../ops/git.ts';
import { classifyExit, type Classification } from '../scheduler/execute.ts';
import { attributeCommits, type RangeFetcher } from './diff.ts';
import { INDEX_TIMEOUT_MS, syncAndEmbed, type IndexStep } from './reindex.ts';

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
 * One page-level removal, run after the revert commit and BEFORE the sync: the
 * slug the reverted file derived, what happened to it, and why in one line.
 *
 * F15 is the reason this step exists at all. `sync` reconciles the
 * anchor..HEAD delta, so a file whose addition and removal both landed inside
 * that delta nets to nothing; the page an agent run writes is brain-first (MCP
 * `put_page` embeds it inline), and `embed --stale` only ever re-embeds. Without
 * a delete by name, the reverted page keeps answering searches.
 */
export type PagePurge = {
  slug: string;
  /** The tree path the revert removed, which derived this slug. */
  removedPath: string;
  /**
   * `purged` — the op's own receipt said the row and its chunks are gone;
   * `absent` — no page at that slug in the write Space (nothing to remove);
   * `skipped_file_present` — the slug is STILL a file in the write Space, so it
   *   is live work rather than a reverted page: nothing was touched;
   * `skipped_not_a_page` — the path derives no slug this module can trust;
   * `refused_unreadable` — the tree could not be read, so the guard could not
   *   tell live work from a reverted page: nothing was touched and the revert
   *   FAILS (a refusal is never permission);
   * `failed` — the op ran and did not remove the page.
   */
  outcome: 'purged' | 'absent' | 'skipped_file_present' | 'skipped_not_a_page'
    | 'refused_unreadable' | 'failed';
  /** One line the console and the Runs page can render verbatim. */
  detail: string;
  /** The argv the op path built — worth recording even when the op never ran. */
  argv: string[];
  /** null when the guard skipped the call: no op produced an exit code. */
  exitCode: number | null;
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
  /**
   * The remove-by-name step, then both scheduler steps — always all three: a
   * re-index that did not complete throws instead. `purge` is EMPTY when the
   * revert removed no page-shaped file, which is the honest shape for a revert
   * of edits only.
   */
  index: { purge: PagePurge[]; sync: IndexStep; embed: IndexStep };
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
  /** F16 — what the write Space's WORKING TREE holds at each path, tracked or
   *  not. Injectable for the same reason the rest is: the guard's three
   *  outcomes (skip a live file, purge a reverted page, refuse an unreadable
   *  tree) are worth proving without a repo behind them. */
  probeTree: (sourceId: string, paths: readonly string[]) => Promise<TreeProbe>;
  callOps: typeof callOps;
  /**
   * The 0.51 gate, injected like the rest: a test proves the `--force` purge
   * argv without moving the declared pin. Production uses the real function.
   */
  pageDeleteNeedsForce: typeof pageDeleteNeedsForce;
  now: () => number;
};

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

  const index = await reindex(sourceId, outcome.files, deps);
  const embed = index.embed;
  if (embed === null || index.sync.classification !== 'ok' || embed.classification !== 'ok') {
    const failing = embed ?? index.sync;
    throw new Error(
      `revert commit ${outcome.sha} landed for run ${runId} but the brain index did not move: `
      + `${failing.argv.join(' ')} exited ${failing.exitCode} (${failing.classification}) `
      + `${failing.stderr.trim()}. Honesty rule 7: a reverted file that still answers searches is not reverted.`,
    );
  }

  // The remove-by-name step is the one the scheduler steps cannot stand in for
  // (F15): a purge that failed or that the guard could not even attempt leaves
  // the reverted page in the index, which is exactly the state this route must
  // never report as a revert. A skip with a reason is NOT that state — see
  // `purgeRemovedPages`.
  const unpurged = index.purge.filter(
    (p) => p.outcome === 'failed' || p.outcome === 'refused_unreadable',
  );
  if (unpurged.length > 0) {
    const failed = unpurged[0]!;
    throw new Error(
      `revert commit ${outcome.sha} landed for run ${runId} and ${sourceId} was re-synced, but the `
      + `reverted page ${failed.slug} was not removed from the brain index (${failed.outcome}): `
      + `${failed.argv.join(' ')} exited ${failed.exitCode ?? 'no call'} `
      + `(${failed.classification}) ${failed.stderr.trim() || failed.detail}. `
      + 'Honesty rule 7: a reverted file that still answers searches is not reverted.',
    );
  }

  return {
    reverted: true,
    runId,
    sourceId,
    revertCommit: outcome.sha,
    revertedAt: at.toISOString(),
    files: outcome.files,
    index: { purge: index.purge, sync: index.sync, embed },
  };
}

/**
 * Step 3, through the NORMAL scheduler command path: the same
 * `SCHEDULER_COMMANDS` entries, the same Connection fence (`fenceParams` derives
 * `--source` from the write Space, so a caller cannot supply it), the same ops
 * RPC argv build. No shell, and never gbrain straight from the control plane (S2).
 *
 * The page-level removals come FIRST, and they are not optional decoration on
 * the sync: `sync` reconciles `anchor..HEAD`, so a file whose addition and
 * removal both landed inside that delta nets to NO change (F15, measured), and
 * the page an agent run writes was created brain-first by MCP `put_page` with
 * its chunks embedded inline. Only a delete by name moves it.
 *
 * The embed runs only when sync succeeded — the rule `live-sync`'s step 2 carries:
 * embedding a half-imported Space commits chunks of a state sync never reached.
 */
async function reindex(
  writeSourceId: string,
  revertFiles: readonly RangeFile[],
  deps: RevertDeps,
): Promise<{ purge: PagePurge[]; sync: IndexStep; embed: IndexStep | null }> {
  const purge = await purgeRemovedPages(writeSourceId, revertFiles, deps);
  const { sync, embed } = await syncAndEmbed(writeSourceId, deps);
  return { purge, sync, embed };
}

/**
 * The page-shaped paths a revert REMOVED, as slugs. `status` is git's own token,
 * and only a `D` names a path that is now gone — a file the revert merely
 * MODIFIED (`M`) is re-synced from its new content and must not be touched: the
 * page it derives may be another run's, and the revert did not remove it.
 *
 * The slug derivation mirrors gbrain's own (`src/core/sync.ts`, `slugifyPath`):
 * strip `.md`/`.mdx`, then per segment lower-case and collapse runs of
 * whitespace to a hyphen. A path whose segment carries anything outside
 * letters/digits/dots/underscores/hyphens/spaces derives no slug here — that is
 * the emoji/CJK case gbrain imports under a FRONTMATTER slug, and a guarded
 * `null` is the only honest answer; a guessed slug could name another page.
 */
export function purgeCandidates(files: readonly RangeFile[]): Array<{ path: string; slug: string | null }> {
  const out: Array<{ path: string; slug: string | null }> = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!f.status.startsWith('D')) continue;
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    out.push({ path: f.path, slug: slugForRemovedPath(f.path) });
  }
  return out;
}

const PAGE_SEGMENT_RE = /^[\p{L}\p{N}._\- ]+$/u;

/** null when this path derives no slug this module can stand behind. */
function slugForRemovedPath(relPath: string): string | null {
  const stripped = relPath.replace(/\.mdx?$/i, '');
  if (stripped === relPath) return null; // not markdown: a code file's slug is flattened (slugifyCodePath)
  const segments = stripped.split('/');
  const slugs: string[] = [];
  for (const raw of segments) {
    const segment = raw.normalize('NFC');
    if (!PAGE_SEGMENT_RE.test(segment)) return null;
    const slug = segment.toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (slug === '') return null;
    slugs.push(slug);
  }
  return slugs.length > 0 ? slugs.join('/') : null;
}

/**
 * Remove the pages the revert removed, BY NAME, one delete per slug.
 *
 * Two rules this function exists to get right, both learned from F15:
 *
 *   1. **Only the removed paths.** `purgeCandidates` filters to `D`; a file the
 *      revert edited is re-synced from its content and its page is never touched.
 *   2. **Never purge a page that is still a file.** `gbrain delete --purge`
 *      UNLINKS the page's markdown if it is there, so a slug whose file the tree
 *      still holds is live work — another writer re-created it, or the revert
 *      restored it under a name that derives the same slug. Nothing is touched
 *      and the skip is recorded with the path that was found. That check asks
 *      the TREE (`deps.probeTree`), never the revert's own file list, because
 *      the file list is a memory of git. Both the removed path and the slug's
 *      own `<slug>.md` are probed: a page re-created at its canonical path is
 *      live whether or not the removed path is the one that came back.
 *
 * The probe's own failure is NOT a skip: a guard that could not look has no
 * evidence the file is gone, and "absence of evidence is a pass" is the failure
 * `src/upgrade/digest.ts` names. Those candidates come back
 * `refused_unreadable`, and `revertRun` throws on them.
 */
async function purgeRemovedPages(
  writeSourceId: string,
  revertFiles: readonly RangeFile[],
  deps: RevertDeps,
): Promise<PagePurge[]> {
  const spec = OPERATIONS['page.delete'];
  if (!spec) throw new Error('the registry is missing page.delete');

  const candidates = purgeCandidates(revertFiles);
  if (candidates.length === 0) return [];

  // The params are built ONCE per slug and the recorded argv is derived from
  // those same params, so `PagePurge.argv` is always the command that ran — the
  // 0.51 `--force` included. A second literal here is how the receipt drifts.
  const paramsFor = (slug: string) => ({
    slug, sourceId: writeSourceId, purge: true,
    ...(deps.pageDeleteNeedsForce() ? { force: true } : {}),
  });
  const argvFor = (params: ReturnType<typeof paramsFor>) => redactArgv(spec, ['gbrain', ...buildArgv(
    spec, params, { json: true },
  )]);
  const skipped = (
    c: { path: string; slug: string | null }, outcome: PagePurge['outcome'], detail: string,
  ): PagePurge => ({
    slug: c.slug ?? c.path,
    removedPath: c.path,
    outcome,
    detail,
    argv: c.slug === null ? [] : argvFor(paramsFor(c.slug)),
    exitCode: null,
    stderr: '',
    classification: 'refused',
  });

  // One probe for every path that could veto a purge, before any delete runs:
  // a guard that asks per-slug after the first removal would already have
  // unlinked files by the time it refused.
  const probePaths = [...new Set(candidates.flatMap((c) => (
    c.slug === null ? [c.path] : [c.path, `${c.slug}.md`]
  )))];
  let probe: TreeProbe | null = null;
  let probeFailure = '';
  try {
    probe = await deps.probeTree(writeSourceId, probePaths);
  } catch (e) {
    probeFailure = e instanceof Error ? e.message : String(e);
  }

  const present = new Set((probe?.paths ?? []).filter((p) => p.onDisk).map((p) => p.path));
  const out: PagePurge[] = [];

  for (const c of candidates) {
    if (c.slug === null) {
      out.push(skipped(
        c, 'skipped_not_a_page',
        `${c.path} derives no slug this path can stand behind (a non-markdown file, or a name gbrain `
        + 'imports under a frontmatter slug), so no page was removed for it',
      ));
      continue;
    }
    if (probe === null) {
      out.push(skipped(
        c, 'refused_unreadable',
        `the write Space's working tree could not be read (${probeFailure}), so the purge guard has no `
        + 'evidence that the removed file is gone and nothing was removed',
      ));
      continue;
    }
    const twin = `${c.slug}.md`;
    const stillThere = [c.path, twin].find((p) => present.has(p));
    if (stillThere !== undefined) {
      out.push(skipped(
        c, 'skipped_file_present',
        `${stillThere} is still in the write Space's working tree, so ${c.slug} is live work rather than a `
        + 'reverted page: nothing was removed',
      ));
      continue;
    }

    const params = paramsFor(c.slug);
    const argv = argvFor(params);
    try {
      const r = await deps.callOps('page.delete', params, { json: true, timeoutMs: INDEX_TIMEOUT_MS });
      const receipt = r.json as { status?: unknown } | null;
      const classification = classifyExit('page.delete', r.exitCode, r.json);
      const purged = r.exitCode === 0 && receipt?.status === 'purged';
      // An absent slug is a RESULT, not a failure: the op exits 1 with
      // `Error [page_not_found]: …` on stderr and no JSON receipt (measured at
      // the pin), which for a reverted path means sync never imported it and
      // there is no page to remove.
      const absent = r.exitCode !== 0 && r.stderr.includes('page_not_found');
      out.push({
        slug: c.slug,
        removedPath: c.path,
        outcome: purged ? 'purged' : absent ? 'absent' : 'failed',
        detail: purged
          ? `removed from ${writeSourceId}'s index by name`
          : absent
            ? `no page at ${c.slug} in ${writeSourceId}: there was nothing to remove`
            : `the delete did not report a purge (exit ${r.exitCode})`,
        argv,
        exitCode: r.exitCode,
        stderr: r.stderr,
        classification,
      });
    } catch (e) {
      // The op never produced an exit code: -1 classifies as a plain failure,
      // the same line `runIndexStep` holds.
      out.push({
        slug: c.slug,
        removedPath: c.path,
        outcome: 'failed',
        detail: 'the ops RPC failed before the delete produced an exit code',
        argv,
        exitCode: -1,
        stderr: e instanceof Error ? e.message : String(e),
        classification: classifyExit('page.delete', -1, null),
      });
    }
  }
  return out;
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
  probeTree: gitPathExists,
  callOps,
  pageDeleteNeedsForce,
  now: () => Date.now(),
};
