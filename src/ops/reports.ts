import { access, mkdir } from 'node:fs/promises';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SQL } from 'bun';
import { commitAs } from './git.ts';

const REPOS_ROOT = process.env.BRAIN_REPOS ?? '/srv/brain-repos';

/** Same shape seedSpaceRepo and commitAs enforce — no separators, no traversal. */
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The reports/<job-name>/ directory segment. */
const JOB_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** YYYY-MM-DD-HHMM, optionally the DST second-pass suffix. */
const STAMP_RE = /^\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?$/;

/**
 * Upstream's output convention, verbatim:
 *   skills/cron-scheduler/SKILL.md:30 —
 *   "Results saved as reports: reports/{job-name}/{YYYY-MM-DD-HHMM}.md"
 * Both segments are validated, never sanitized: a job name that would escape
 * the repo is an error the operator must see, not something we quietly rewrite.
 */
export function reportRelPath(job: string, stamp: string): string {
  if (!JOB_RE.test(job)) throw new Error(`invalid job name: ${JSON.stringify(job)}`);
  if (!STAMP_RE.test(stamp)) throw new Error(`invalid report stamp: ${JSON.stringify(stamp)}`);
  return `reports/${job}/${stamp}.md`;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/**
 * Resolve the first free target. A DST fall-back can produce the same local
 * stamp twice for a sub-hourly job; so can a manual re-run. We never overwrite
 * a report — the run row records which path it actually wrote.
 */
export async function resolveReportTarget(
  root: string, sourceId: string, job: string, stamp: string,
): Promise<{ absPath: string; relPath: string }> {
  if (!SOURCE_ID_RE.test(sourceId)) throw new Error(`invalid sourceId: ${sourceId}`);
  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? stamp : `${stamp}-${n}`;
    const relPath = reportRelPath(job, candidate);
    const absPath = join(root, sourceId, relPath);
    if (!(await exists(absPath))) return { absPath, relPath };
  }
  throw new Error(`could not find a free report path for ${job}/${stamp}`);
}

/** Atomic within one directory: a reader never sees a torn report (S3). */
async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contents, { mode: 0o644 });
  await rename(tmp, path);
}

/**
 * Write a run report into the Connection's write Space and commit it AS the
 * member who owns that Connection. Serialized under the SAME per-repo advisory
 * lock the rest of the file plane uses (S3) — commitAs takes `repo:<sourceId>`
 * via withRepoLock, so the write must happen inside that same critical section,
 * not before it, or a concurrent gbrain sync can observe a half-written tree.
 *
 * Sync imports COMMITS, not the working tree (unless sync.include_working_tree
 * is set), so an uncommitted report is a page the brain cannot see. Writing
 * without committing would be a silent data-loss bug.
 */
export async function writeReport(
  args: {
    sourceId: string;
    job: string;
    stamp: string;
    body: string;
    actor: { name: string; email: string };
  },
  opts: { sql: SQL; root?: string },
): Promise<{ relPath: string; committed: boolean; sha: string | null }> {
  const root = opts.root ?? REPOS_ROOT;
  const target = await resolveReportTarget(root, args.sourceId, args.job, args.stamp);
  await atomicWrite(target.absPath, args.body);
  const commit = await commitAs(
    args.sourceId, args.actor, `reports: ${args.job} ${args.stamp}`, { sql: opts.sql, root },
  );
  return { relPath: target.relPath, ...commit };
}
