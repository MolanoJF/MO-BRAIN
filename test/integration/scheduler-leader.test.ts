import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { lockKeyToBigint } from '../../src/ops/lock.ts';
import { LEADER_LOCK_KEY, tryAcquireLeadership, withLeadership } from '../../src/scheduler/leader.ts';

let a: ReturnType<typeof postgres>;
let b: ReturnType<typeof postgres>;

beforeAll(() => {
  const url = process.env.CONTROL_DATABASE_URL!;
  a = postgres(url, { max: 5 });
  b = postgres(url, { max: 5 });
});

afterAll(async () => { await a.end(); await b.end(); });

describe('leader election', () => {
  test('the key is stable and namespaced, not a bare number', () => {
    expect(LEADER_LOCK_KEY).toBe('scheduler:leader');
  });

  test('exactly one of two candidates becomes leader', async () => {
    const first = await tryAcquireLeadership(a);
    expect(first).not.toBeNull();
    const second = await tryAcquireLeadership(b);
    expect(second).toBeNull();
    await first!.release();
  });

  test('releasing hands leadership to the next candidate', async () => {
    const first = await tryAcquireLeadership(a);
    await first!.release();
    const second = await tryAcquireLeadership(b);
    expect(second).not.toBeNull();
    await second!.release();
  });

  test('the lock is actually released in Postgres, not just in our object', async () => {
    const lead = await tryAcquireLeadership(a);
    await lead!.release();
    // Other suites hold file-plane locks, so counting pg_locks proves nothing.
    // Assert OUR key specifically is reacquirable from a different pool.
    const key = lockKeyToBigint(LEADER_LOCK_KEY).toString();
    const conn = await b.reserve();
    try {
      const [row] = await conn`select pg_try_advisory_lock(${key}::bigint) as got`;
      expect(row!.got).toBe(true);
      await conn`select pg_advisory_unlock(${key}::bigint)`;
    } finally {
      conn.release();
    }
  });

  test('release is idempotent — a double release does not unlock someone else', async () => {
    const lead = await tryAcquireLeadership(a);
    await lead!.release();
    const other = await tryAcquireLeadership(b);
    expect(other).not.toBeNull();
    await lead!.release(); // second call: must be a no-op
    expect(other!.held).toBe(true);
    await other!.release();
  });

  test('two concurrent withLeadership calls never both run the body', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const body = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Bun.sleep(250);
      concurrent -= 1;
    };
    const [ranA, ranB] = await Promise.all([withLeadership(a, body), withLeadership(b, body)]);
    expect(maxConcurrent).toBe(1);
    expect([ranA, ranB].filter(Boolean).length).toBe(1);
  });

  test('a throwing body still releases leadership', async () => {
    await expect(withLeadership(a, async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    const next = await tryAcquireLeadership(b);
    expect(next).not.toBeNull();
    await next!.release();
  });
});
