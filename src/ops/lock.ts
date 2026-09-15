import { createHash } from 'node:crypto';
import type { SQL } from 'bun';

/**
 * Map a human lock name to the signed 64-bit integer pg_advisory_lock takes.
 * A Postgres advisory lock, not a file lock: multiple containers share the
 * GBRAIN_HOME volume, so a flock on that volume protects nothing (S3).
 */
export function lockKeyToBigint(key: string): bigint {
  const digest = createHash('sha256').update(key).digest();
  const unsigned = digest.readBigUInt64BE(0);
  return BigInt.asIntN(64, unsigned);
}

export async function withAdvisoryLock<T>(
  sql: SQL,
  key: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const lockId = lockKeyToBigint(key);
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);

  // pg_advisory_lock is SESSION-scoped and re-entrant WITHIN a session, while
  // `sql` is a connection POOL. Reserve one connection so the acquire, the
  // critical section and the release provably share a single backend. On a
  // bare pooled handle two things can go wrong silently: the unlock lands on a
  // different connection (returns false, lock leaks until that backend dies),
  // and two concurrent callers handed the same connection BOTH acquire the
  // lock — mutual exclusion gone, with no error anywhere. S3 depends on this.
  const conn = await sql.reserve();
  try {
    for (;;) {
      const [row] = await conn`select pg_try_advisory_lock(${lockId}::bigint) as got`;
      if (row?.got) break;
      if (Date.now() > deadline) throw new Error(`timed out acquiring advisory lock ${key}`);
      await Bun.sleep(100);
    }

    try {
      return await fn();
    } finally {
      await conn`select pg_advisory_unlock(${lockId}::bigint)`;
    }
  } finally {
    conn.release();
  }
}

/**
 * Merge a patch into config.json. Never blind-writes: an unparseable document
 * is a signal something else is mid-write or corrupt, and overwriting it is
 * exactly the API-key-eating failure S3 exists to prevent.
 */
export function mergeConfigJson(current: string | null, patch: Record<string, unknown>): string {
  let base: Record<string, unknown> = {};
  if (current !== null && current.trim() !== '') {
    try {
      base = JSON.parse(current) as Record<string, unknown>;
    } catch {
      throw new Error('refusing to overwrite unparseable config.json');
    }
  }
  return JSON.stringify({ ...base, ...patch }, null, 2) + '\n';
}
