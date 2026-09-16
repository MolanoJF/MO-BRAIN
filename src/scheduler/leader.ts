import type { Sql } from 'postgres';
import { lockKeyToBigint } from '../ops/lock.ts';

/**
 * One leader materializes occurrences; every other replica is a worker. The
 * lock lives in the CONTROL database — the same place the file-plane lock does
 * (S3) — and is held for the whole leadership term on a RESERVED connection.
 *
 * The reservation is not an optimization. pg_advisory_lock is session-scoped
 * and `sql` is a pool: on a bare pooled handle the unlock can land on a
 * different backend (the lock leaks until that backend dies) and two callers
 * handed the same connection BOTH acquire it. Two leaders double-materialize
 * every schedule. See src/ops/lock.ts:24-31.
 */
export const LEADER_LOCK_KEY = 'scheduler:leader';

export type Leadership = { held: boolean; release(): Promise<void> };

export async function tryAcquireLeadership(
  sql: Sql, key: string = LEADER_LOCK_KEY,
): Promise<Leadership | null> {
  // postgres.js binds `bigint` at runtime (`inferType` → OID 20) but its
  // published parameter types deliberately exclude it — so bind the exact
  // decimal text and let the `::bigint` cast pin the server-side type. A JS
  // `number` would silently lose precision on the high half of the int64 range.
  const lockId = lockKeyToBigint(key).toString();
  const conn = await sql.reserve();
  try {
    const [row] = await conn`select pg_try_advisory_lock(${lockId}::bigint) as got`;
    if (!row?.got) {
      conn.release();
      return null;
    }
  } catch (e) {
    conn.release();
    throw e;
  }

  let released = false;
  const leadership: Leadership = {
    held: true,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      leadership.held = false;
      try {
        await conn`select pg_advisory_unlock(${lockId}::bigint)`;
      } finally {
        conn.release();
      }
    },
  };
  return leadership;
}

/** Run `fn` only if this process wins the lock. Returns whether it ran. */
export async function withLeadership(
  sql: Sql, fn: (leadership: Leadership) => Promise<void>, key: string = LEADER_LOCK_KEY,
): Promise<boolean> {
  const leadership = await tryAcquireLeadership(sql, key);
  if (!leadership) return false;
  try {
    await fn(leadership);
    return true;
  } finally {
    await leadership.release();
  }
}
