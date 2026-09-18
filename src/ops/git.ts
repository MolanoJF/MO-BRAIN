import { statSync } from 'node:fs';
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

/** One commit in a `<before>..<after>` range (D9). The author is whatever git
 *  recorded — gbrain commits inside upstream code (G3), so it is not ours to set. */
export type RangeCommit = {
  sha: string;
  author: string;
  email: string;
  subject: string;
  /** Author date, ISO-8601. */
  at: string;
};

/** One entry of `git diff --name-status`. `status` is git's own token (A/M/D/R100…),
 *  not a normalization; `path` is the post-image path. */
export type RangeFile = { status: string; path: string };

export type GitRange = {
  sourceId: string;
  /** The refs resolved to commit shas. A caller that only wants the head (captureHeads)
   *  asks for the degenerate `HEAD..HEAD` range and reads `after`. */
  before: string;
  after: string;
  commits: RangeCommit[];
  files: RangeFile[];
};

/**
 * One `/git/revert-range` request: the range to invert, plus the identity and
 * the message of the human who signs the revert commit. D10 step 2 — the audit
 * story is that a named admin reverted the run, never that "the system" did.
 */
export type RevertRequest = {
  sourceId: string;
  before: string;
  after: string;
  actor: { name: string; email: string };
  message: string;
};

/**
 * What a revert did, in three explicit outcomes (D10). `nothing_to_revert` is
 * the already-reverted case — the inverse diff is empty, exactly when the
 * `commitAs` sequence would report `committed: false`. `conflict` carries git's
 * own words and means the repo was left exactly as it was found.
 */
export type RevertOutcome =
  | { reverted: true; sha: string; files: RangeFile[] }
  | { reverted: false; reason: 'nothing_to_revert' }
  | { reverted: false; reason: 'conflict'; detail: string };

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

async function git(cwd: string, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(['git', ...argv], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** git's own words when a call failed — never a bare "it failed". */
function gitFailure(r: { exitCode: number; stdout: string; stderr: string }): string {
  return r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`;
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

/** Record separator for `--format`: %s cannot contain a newline, so lines are records. */
const FIELD = '\u001f';

/** Resolve a ref to a commit sha, or refuse by name. `git log bogus..HEAD` exits 128
 *  with EMPTY stdout — the same shape as "no changes" — so both endpoints are
 *  resolved up front and a bad ref is an explicit error (absence of evidence is
 *  never a pass; `src/upgrade/digest.ts` holds the same line). */
async function resolveCommit(cwd: string, ref: string): Promise<string> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  if (r.exitCode !== 0 || !sha) throw new Error(`unknown ref: ${ref}`);
  return sha;
}

/** `H<US>author<US>email<US>subject<US>ISO-date` per commit, oldest first. */
function parseLog(stdout: string): RangeCommit[] {
  const out: RangeCommit[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const parts = line.split(FIELD);
    const [sha, author, email] = parts;
    if (!sha || !author) continue;
    out.push({
      sha,
      author,
      email: email ?? '',
      // The subject is the only field that could ever hold a stray separator.
      subject: parts.slice(3, -1).join(FIELD),
      at: parts.at(-1) ?? '',
    });
  }
  return out;
}

/** `STATUS<TAB>path`, or `STATUS<TAB>old<TAB>new` for renames/copies — we keep
 *  the post-image path and git's raw status token. */
function parseNameStatus(stdout: string): RangeFile[] {
  const out: RangeFile[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [status, ...paths] = line.split('\t');
    const path = paths.at(-1);
    if (!status || !path) continue;
    out.push({ status, path });
  }
  return out;
}

/**
 * D9 — the read-only brain diff for one Space. Under the repo lock so Task 10's
 * revert can sit beside it; read-only, and never `commitAs` inside (nesting two
 * advisory locks on a reserved pooled connection deadlocks a small pool).
 *
 * A `<before>..<after>` on a missing or unreadable ref throws. `after === before`
 * is a valid empty range and the way captureHeads reads a head.
 */
export async function diffRange(
  sourceId: string,
  before: string,
  after: string,
  opts: { sql: SQL; root?: string },
): Promise<GitRange> {
  if (!SOURCE_ID_RE.test(sourceId)) throw new Error(`invalid sourceId: ${sourceId}`);
  const cwd = join(opts.root ?? REPOS_ROOT, sourceId);
  return withRepoLock(opts.sql, sourceId, async () => {
    const from = await resolveCommit(cwd, before);
    const to = await resolveCommit(cwd, after);

    const log = await git(cwd, [
      'log', '--reverse', `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%s${FIELD}%aI`, `${from}..${to}`,
    ]);
    if (log.exitCode !== 0) throw new Error(`git log ${sourceId} failed: ${gitFailure(log)}`);

    const diff = await git(cwd, ['diff', '--name-status', from, to]);
    if (diff.exitCode !== 0) throw new Error(`git diff ${sourceId} failed: ${gitFailure(diff)}`);

    return {
      sourceId, before: from, after: to,
      commits: parseLog(log.stdout),
      files: parseNameStatus(diff.stdout),
    };
  });
}

/** One path's state in a Space's working tree. TWO observations, never one
 *  derived from the other: what the filesystem holds, and what git knows. */
export type TreePathState = {
  /** The repo-relative path, as validated — never the caller's raw string. */
  path: string;
  /** `stat` found something at `<repo>/<path>`. This is the fact a caller that
   *  is about to UNLINK that file needs. */
  onDisk: boolean;
  /** `git ls-files` knows the path (in the index, or untracked and not
   *  ignored). A file a second writer re-created after a commit is usually
   *  untracked, which is why this is reported beside `onDisk` rather than
   *  instead of it. */
  inGit: boolean;
};

export type TreeProbe = { sourceId: string; root: string; paths: TreePathState[] };

/**
 * Refuse anything that could name a file outside the Space, or that git could
 * read as an option: an absolute path, a `..` segment, a leading `-`, a
 * backslash separator (git pathspecs use `/`), an empty segment, or NUL. The
 * pathspec passed to git still carries `--`, because a name that merely LOOKS
 * like an option must never become one.
 */
function assertRepoRelative(rel: string): string {
  if (typeof rel !== 'string' || rel === '') throw new Error('path must be a non-empty string');
  if (rel.includes('\0')) throw new Error('path must not contain NUL');
  if (rel.startsWith('/') || rel.startsWith('-')) {
    throw new Error(`path must be repo-relative and must not start with '/' or '-': ${rel}`);
  }
  if (rel.includes('\\')) throw new Error(`path must use '/' as its separator: ${rel}`);
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`path must not contain empty, '.' or '..' segments: ${rel}`);
  }
  return rel;
}

/**
 * READ-ONLY. What a Space's WORKING TREE holds at each path, tracked or not.
 *
 * `revertRun`'s purge guard is the reason this exists: `gbrain delete <slug>
 * --purge` unlinks the page's markdown file if it is there, and a reverted file
 * whose path some other writer has since re-created is LIVE work, not a
 * reverted page. The revert's own file list is a memory of git, so the guard
 * has to ask the tree — and the tree lives here, behind ops (S2).
 *
 * An unreadable repo, an invalid `sourceId`, a path that fails validation, or a
 * stat error that is neither ENOENT nor ENOTDIR THROWS: "I could not look" must
 * never come back as `onDisk: false`, because a caller that reads it as absence
 * would delete live work.
 */
export async function probeTreePaths(
  sourceId: string,
  paths: readonly string[],
  opts: { sql: SQL; root?: string },
): Promise<TreeProbe> {
  if (!SOURCE_ID_RE.test(sourceId)) throw new Error(`invalid sourceId: ${sourceId}`);
  const wanted = paths.map(assertRepoRelative);
  const cwd = join(opts.root ?? REPOS_ROOT, sourceId);

  return withRepoLock(opts.sql, sourceId, async () => {
    // Resolve the root first: if the Space has no repo, this fails by name
    // rather than reporting every path absent.
    const top = await git(cwd, ['rev-parse', '--show-toplevel']);
    if (top.exitCode !== 0) throw new Error(`git rev-parse ${sourceId} failed: ${gitFailure(top)}`);
    const root = top.stdout.trim();

    const listed = await git(cwd, [
      'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...wanted,
    ]);
    if (listed.exitCode !== 0) throw new Error(`git ls-files ${sourceId} failed: ${gitFailure(listed)}`);
    const known = new Set(listed.stdout.split('\0').filter(Boolean));

    return {
      sourceId,
      root,
      paths: wanted.map((rel) => ({ path: rel, onDisk: statOrThrow(join(cwd, rel)), inGit: known.has(rel) })),
    };
  });
}

/** `stat` as evidence, not as a default: ENOENT/ENOTDIR are the only answers
 *  that mean "absent"; anything else (EACCES, ELOOP, an I/O error) refuses. */
function statOrThrow(absPath: string): boolean {
  try {
    statSync(absPath);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw new Error(`could not stat ${absPath}: ${code ?? String(e)}`);
  }
}

/**
 * Put a failed revert back, then PROVE it. The pre-flight proved the tracked
 * worktree clean, so HEAD plus an empty tracked status IS byte-identity. A
 * restore we cannot verify throws rather than reporting a refusal over a
 * half-moved tree: a half-reverted brain is worse than a failed revert.
 */
async function restoreRevert(cwd: string, head: string, sourceId: string): Promise<void> {
  const aborted = await git(cwd, ['revert', '--abort']);
  // A single-commit revert leaves no sequencer for `--abort` to unwind; `--quit`
  // clears the in-progress state and the hard reset below does the restoring.
  if (aborted.exitCode !== 0) await git(cwd, ['revert', '--quit']);
  await git(cwd, ['reset', '--hard', head]);

  const status = await git(cwd, ['status', '--porcelain', '--untracked-files=no']);
  const now = await git(cwd, ['rev-parse', 'HEAD']);
  if (status.exitCode !== 0 || now.exitCode !== 0
    || status.stdout.trim() !== '' || now.stdout.trim() !== head) {
    throw new Error(`revert left ${sourceId} unrestorable: HEAD is `
      + `${now.stdout.trim() || gitFailure(now)}, status is ${JSON.stringify(status.stdout.trim())}`);
  }
}

/**
 * D10 steps 1 and 2 — the range comes back as ONE new commit, never a history
 * rewrite.
 *
 * The whole sequence (`git revert --no-commit`, the staged check, the commit)
 * lives inside a single `withRepoLock` body, and MUST: `withRepoLock` holds a
 * reserved pooled connection for the entire critical section, so composing the
 * exported `commitAs` here — which takes that same lock itself — would reserve a
 * SECOND connection while holding the first and deadlock a small pool. The
 * private `git()` helper is what this composes instead.
 *
 * `SOURCE_ID_RE` stays module-private: the validation belongs where the path is
 * built, not in a route that could forget it. An invalid `sourceId` or a ref git
 * cannot resolve THROWS — those are caller bugs, not refusals.
 */
export async function revertRange(
  req: RevertRequest,
  opts: { sql: SQL; root?: string },
): Promise<RevertOutcome> {
  const { sourceId, before, after, actor, message } = req;
  if (!SOURCE_ID_RE.test(sourceId)) throw new Error(`invalid sourceId: ${sourceId}`);
  const cwd = join(opts.root ?? REPOS_ROOT, sourceId);

  return withRepoLock(opts.sql, sourceId, async () => {
    const from = await resolveCommit(cwd, before);
    const to = await resolveCommit(cwd, after);
    if (from === to) return { reverted: false, reason: 'nothing_to_revert' };

    // Refuse BEFORE mutating anything when the tree is not clean: `--abort`
    // restores the paths a revert touched, our backstop is a hard reset, and
    // neither is allowed to take someone's uncommitted work with it. UNTRACKED
    // files are excluded on purpose — a hard reset cannot lose them, and gbrain's
    // own writes arrive as tracked commits.
    const dirty = await git(cwd, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty.exitCode !== 0) throw new Error(`git status ${sourceId} failed: ${gitFailure(dirty)}`);
    const drift = dirty.stdout.split('\n').filter((l) => l.trim());
    if (drift.length > 0) {
      const shown = drift.length > 1 ? `${drift[0]} (+${drift.length - 1} more)` : drift[0];
      return {
        reverted: false,
        reason: 'conflict',
        detail: `uncommitted changes in ${sourceId}: ${shown}`,
      };
    }

    const head = await resolveCommit(cwd, 'HEAD');

    const rev = await git(cwd, ['revert', '--no-commit', `${from}..${to}`]);
    if (rev.exitCode !== 0) {
      // git leaves the working tree mid-conflict here; put it back and prove it.
      await restoreRevert(cwd, head, sourceId);
      return { reverted: false, reason: 'conflict', detail: gitFailure(rev) };
    }

    // `--no-commit` stages its own work, so an empty index is an empty inverse
    // diff: the range is already back and there is nothing to commit. This is the
    // shape `commitAs` reports as `committed: false`.
    // `--no-renames` is F16's, and it is not cosmetic: with rename detection on,
    // the inverse of a rename is reported as ONE `R100 <pre> <post>` row, and
    // `parseNameStatus` keeps the POST-image path — so the path the revert
    // REMOVED (`b.md` in `git mv a.md b.md`, reverted) would appear only as a
    // pre-image, and a caller that removes pages by name could not see it.
    // Measured: `git diff --cached --name-status` answers `R100 b.md a.md` for
    // that revert, and `--no-renames` answers `A a.md` + `D b.md` — what the
    // revert actually did to the tree.
    const staged = await git(cwd, ['diff', '--cached', '--name-status', '--no-renames']);
    if (staged.exitCode !== 0) throw new Error(`git diff --cached ${sourceId} failed: ${gitFailure(staged)}`);
    if (!staged.stdout.trim()) return { reverted: false, reason: 'nothing_to_revert' };

    const commit = await git(cwd, commitArgs(actor, message));
    if (commit.exitCode !== 0) {
      await restoreRevert(cwd, head, sourceId);
      throw new Error(`git commit failed for ${sourceId}: ${gitFailure(commit)}`);
    }

    return {
      reverted: true,
      sha: await resolveCommit(cwd, 'HEAD'),
      files: parseNameStatus(staged.stdout),
    };
  });
}
