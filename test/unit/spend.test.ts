// test/unit/spend.test.ts
import { describe, expect, test } from 'bun:test';
import { rollup } from '../../src/control/spend.ts';

const run = (over: Partial<any> = {}) => ({
  runId: 'r1', memberId: 'm1', memberLabel: 'alice@example.test',
  costUsd: '0.25', ...over,
});

describe('rollup (D9)', () => {
  test('sums per key and counts runs', () => {
    const rows = rollup([run(), run({ runId: 'r2', costUsd: '0.75' })], 'memberId', 'memberLabel');
    expect(rows).toEqual([{ key: 'm1', label: 'alice@example.test', runs: 2, costUsd: 1, unpricedRuns: 0 }]);
  });

  // Honesty rule 3, at the aggregate level.
  test('an unpriced run is counted, and does not read as zero', () => {
    const rows = rollup([run({ costUsd: '1.00' }), run({ runId: 'r2', costUsd: null })], 'memberId', 'memberLabel');
    expect(rows[0]!.costUsd).toBe(1);        // the priced part
    expect(rows[0]!.runs).toBe(2);
    expect(rows[0]!.unpricedRuns).toBe(1);   // and the part we could not price
  });

  test('every run being unpriced gives a NULL total, never 0', () => {
    const rows = rollup([run({ costUsd: null })], 'memberId', 'memberLabel');
    expect(rows[0]!.costUsd).toBeNull();
  });

  // D9: connection_id is `on delete set null` so the audit survives.
  test('a run whose Connection is gone rolls up as unattributed, on its own row', () => {
    const rows = rollup([run(), run({ runId: 'r2', memberId: null, memberLabel: null })],
                        'memberId', 'memberLabel');
    expect(rows.map((r) => r.key).sort()).toEqual(['m1', 'unattributed']);
    expect(rows.find((r) => r.key === 'unattributed')!.label).toBe('Unattributed (Connection deleted)');
  });
});
