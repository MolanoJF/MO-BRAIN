import { test, expect } from 'bun:test';
import journal from '../../src/control/db/migrations/meta/_journal.json' with { type: 'json' };

/**
 * Regression guard for the 0013 outage: drizzle-orm's migrator only applies a
 * migration when its journal timestamp (`when`) is strictly greater than the
 * previously-applied migration's timestamp. This repo hand-sets inflated
 * future timestamps for several migrations (0008+); if a later migration is
 * ever generated with a real (lower) wall-clock timestamp, it will silently
 * never apply on any database that already has the prior migrations applied.
 *
 * See: migration 0013_amazing_bastion originally shipped with `when:
 * 1790539558991`, below 0012's `when: 1793000000000`, which meant it was
 * skipped on every non-fresh database.
 */
test('migration journal entries have strictly increasing `when` timestamps', () => {
  const entries = journal.entries as Array<{ idx: number; when: number; tag: string }>;
  expect(entries.length).toBeGreaterThan(0);

  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const curr = entries[i]!;
    expect(
      curr.when,
      `migration "${curr.tag}" (when=${curr.when}) must have a timestamp strictly greater than ` +
        `the previous migration "${prev.tag}" (when=${prev.when}), or drizzle-orm's migrator will ` +
        `silently skip it on any already-migrated database`,
    ).toBeGreaterThan(prev.when);
  }
});

test('migration journal entries are ordered by idx matching array order', () => {
  const entries = journal.entries as Array<{ idx: number; tag: string }>;
  entries.forEach((entry, i) => {
    expect(entry.idx).toBe(i);
  });
});
