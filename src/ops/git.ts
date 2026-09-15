import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SQL } from 'bun';
import { withAdvisoryLock } from './lock.ts';

const REPOS_ROOT = process.env.BRAIN_REPOS ?? '/srv/brain-repos';
/** Same shape seedSpaceRepo enforces — no path separators, no traversal. */
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A lock held longer than this is a crashed writer, not a concurrent one. */
const STALE_LOCK_SECONDS = 120;

export type RepoStatus = {
  sourceId: string;
  staleLock: boolean;
  lockAgeSeconds: number | null;
  uncommittedFiles: number;
  unpushedCommits: number;
  branch: string | null;
};

export function classifyLock(ageSeconds: number | null): { staleLock: boolean; lockAgeSeconds: number | null } {
  if (ageSeconds === null) return { staleLock: false, lockAgeSeconds: null };
  return { staleLock: ageSeconds > STALE_LOCK_SECONDS, lockAgeSeconds: ageSeconds };
}

/** Commit AS the member: identity per invocation, never a global config write. */
export function commitArgs(actor: { name: string; email: string }, message: string): string[] {
  if (/[\n\r]/.test(actor.name) || /[\n\r]/.test(actor.email)) {
    throw new Error('invalid git identity: newlines are not allowed');
  }
  return [
    '-c', `user.name=${actor.name}`,
    '-c', `user.email=${actor.email}`,
    'commit', '-m', message,
  ];
}

async function git(cwd: string, argv: string[]): Promise<{ exitCode: number; stdout: string }> {
  const p = Bun.spawn(['git', ...argv], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, exitCode] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { exitCode, stdout };
}

/** Report contention and drift across every Space repo. Read-only. */
export async function inspectRepos(root = REPOS_ROOT): Promise<RepoStatus[]> {
  let entries: string[] = [];
  try { entries = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }

  const out: RepoStatus[] = [];
  for (const sourceId of entries) {
    const cwd = join(root, sourceId);

    let lockAge: number | null = null;
    try {
      const s = await stat(join(cwd, '.git', 'index.lock'));
      lockAge = Math.round((Date.now() - s.mtimeMs) / 1000);
    } catch { lockAge = null; }

    const status = await git(cwd, ['status', '--porcelain']);
    const branchRes = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    // Sync imports COMMITS, not the working tree, unless sync.include_working_tree
    // is set — so uncommitted files are pages the brain cannot see yet.
    const unpushed = await git(cwd, ['rev-list', '--count', '@{u}..HEAD']);

    out.push({
      sourceId,
      ...classifyLock(lockAge),
      uncommittedFiles: status.exitCode === 0
        ? status.stdout.split('\n').filter((l) => l.trim()).length : 0,
      unpushedCommits: unpushed.exitCode === 0 ? Number(unpushed.stdout.trim() || '0') : 0,
      branch: branchRes.exitCode === 0 ? branchRes.stdout.trim() : null,
    });
  }
  return out;
}

/**
 * Serialize the commits WE drive. Serve and worker commit inside gbrain's own
 * code and we do not patch upstream (G3), so this narrows the window rather
 * than closing it — the health signal above is what catches the rest.
 */
export async function withRepoLock<T>(sql: SQL, sourceId: string, fn: () => Promise<T>): Promise<T> {
  return withAdvisoryLock(sql, `repo:${sourceId}`, fn, { timeoutMs: 60_000 });
}

export async function commitAs(
  sourceId: string,
  actor: { name: string; email: string },
  message: string,
  opts: { sql: SQL; root?: string },
): Promise<{ committed: boolean; sha: string | null }> {
  if (!SOURCE_ID_RE.test(sourceId)) throw new Error(`invalid sourceId: ${sourceId}`);
  const cwd = join(opts.root ?? REPOS_ROOT, sourceId);
  return withRepoLock(opts.sql, sourceId, async () => {
    await git(cwd, ['add', '-A']);
    const commit = await git(cwd, commitArgs(actor, message));
    if (commit.exitCode !== 0) return { committed: false, sha: null }; // nothing to commit
    const head = await git(cwd, ['rev-parse', 'HEAD']);
    return { committed: true, sha: head.stdout.trim() || null };
  });
}
