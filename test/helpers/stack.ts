import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeUp, composeDown, composeExec } from '../../src/docker/host.ts';

export const PIN = process.env.GBRAIN_VERSION ?? '0.50.0.0';
export const PG_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'change-me-in-a-real-deployment';
export const BRAIN_DB_URL =
  `postgres://gbrain:${PG_PASSWORD}@postgres:5432/${process.env.GBRAIN_DB ?? 'gbrain'}`;

export { composeUp, composeDown, composeExec };

/** Drop every gbrain table so the next test initializes a virgin brain. */
export async function resetBrain(): Promise<void> {
  const stopped = await composeExec('gbrain-ops', ['sh', '/opt/mobrain/quiesce-gbrain-procs.sh'], { timeoutMs: 60_000 });
  if (stopped.exitCode !== 0) {
    throw new Error(`quiesce gbrain procs failed (${stopped.exitCode}): ${stopped.stderr}`);
  }
  await composeExec('gbrain-ops', [
    'psql', BRAIN_DB_URL, '-v', 'ON_ERROR_STOP=1', '-c',
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ' +
    'CREATE EXTENSION IF NOT EXISTS vector; ' +
    'CREATE EXTENSION IF NOT EXISTS pg_trgm; ' +
    'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
  ]);
  await composeExec('gbrain-ops', ['sh', '-c', 'rm -rf /srv/gbrain-home/* /srv/gbrain-home/.[!.]* || true']);
}

/**
 * Plan defect (Work Item D): `gbrain sources add --path <dir>` refuses any
 * path that is not a git repository with at least one committed, tracked
 * file — gbrain walks git objects, so an empty or non-git directory is
 * invisible to sync ("is not a git repository with committed, tracked
 * files ... an empty commit is not enough"). Seed a minimal git repo before
 * registering a source under /srv/brain-repos.
 */
export async function seedGitSource(id: string): Promise<void> {
  const dir = `/srv/brain-repos/${id}`;
  await composeExec('gbrain-ops', ['sh', '-c',
    `set -e; mkdir -p ${dir}; cd ${dir}; git init -q; echo "# ${id}" > README.md; git add -A; ` +
    `git -c user.email=test@mobrain.local -c user.name=mobrain-test commit -q -m seed`,
  ]);
}

// ---------------------------------------------------------------------------
// Mutual exclusion over the live stack's SERVICE STATE.
//
// Exactly two files in `test/integration` mutate which services are running:
// `backup.test.ts` (the real `scripts/backup.ts`: stop scheduler + gbrain-worker,
// verify with `jobs.supervisorStatus`, dump, start them again — and the manifest's
// `quiesced` field IS that verification) and `quiesce.test.ts` (a full
// quiesce/resume round trip over the same services).
//
// `bun test test/integration` runs FILES CONCURRENTLY — that is the plan's
// command, and `--parallel=1` is not an available fix: in one process the suite's
// own partial `mock.module` calls poison each other (measured: 8 fail / 4 files
// that never load). So `quiesce.test.ts`'s `resume()` can land between backup's
// stop and its status read, and backup's own stop/start can land inside quiesce's
// assertions — either way, one file's timing decides another file's verdict.
// Serialising the two legs that touch the stack is the honest fix; serialising
// the whole directory is neither possible nor needed.
//
// This lock covers SERVICE STATE only. The other half of the same pair's
// interference — a sibling file's process-wide `mock.module` of the ops client
// answering backup's probe — is handled inside backup.test.ts, which runs the
// real script in its own process.
//
// The lock is a directory created with `mkdir` (atomic: the loser gets EEXIST)
// under the OS temp dir, so it is shared by every concurrent test process on this
// host and survives a quiesce (it is not on a compose volume). The holder writes
// its pid; a lock whose owner is gone, or whose directory is older than
// STACK_LOCK_STALE_MS, is BROKEN rather than deadlocking the suite. A live holder
// can never be mistaken for stale: the longest leg that takes the lock runs
// under a 600s `test()` timeout, and no single test may outlive it.
const STACK_LOCK_DIR = join(tmpdir(), 'mobrain-stack-exclusion.lock');
const STACK_LOCK_STALE_MS = 30 * 60_000;
const STACK_LOCK_WAIT_MS = 25 * 60_000;
const STACK_LOCK_POLL_MS = 250;

/**
 * Run `fn` while no other file may change the stack's service state. `label`
 * names the holder, so a stuck lock says who to look at.
 */
export async function withStackExclusion<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + STACK_LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(STACK_LOCK_DIR);
      await writeFile(join(STACK_LOCK_DIR, 'owner'), `${label} pid=${process.pid}\n`);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    const owner = await readFile(join(STACK_LOCK_DIR, 'owner'), 'utf8').catch(() => null);
    const st = await stat(STACK_LOCK_DIR).catch(() => null);

    // Signal 0 is a liveness probe; EPERM means alive but owned by another user.
    const pidMatch = /pid=(\d+)/.exec(owner ?? '');
    let holderAlive = true;
    if (pidMatch) {
      try {
        process.kill(Number(pidMatch[1]), 0);
      } catch (e) {
        holderAlive = (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    const abandoned = !holderAlive
      || (st !== null && Date.now() - st.mtimeMs > STACK_LOCK_STALE_MS);
    if (abandoned) {
      await rm(STACK_LOCK_DIR, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `stack exclusion: ${label} waited ${STACK_LOCK_WAIT_MS}ms to change the live stack, `
        + `held by ${owner?.trim() ?? 'an unknown holder'}`,
      );
    }
    await Bun.sleep(STACK_LOCK_POLL_MS);
  }

  try {
    return await fn();
  } finally {
    await rm(STACK_LOCK_DIR, { recursive: true, force: true });
  }
}
