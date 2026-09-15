import { test, expect, describe } from 'bun:test';
import { lockKeyToBigint } from '../../src/ops/lock.ts';

describe('lockKeyToBigint', () => {
  test('is deterministic', () => {
    expect(lockKeyToBigint('fileplane:config.json'))
      .toBe(lockKeyToBigint('fileplane:config.json'));
  });

  test('different keys give different locks', () => {
    expect(lockKeyToBigint('fileplane:config.json'))
      .not.toBe(lockKeyToBigint('fileplane:schema-packs'));
  });

  test('fits in a signed 64-bit integer', () => {
    const v = lockKeyToBigint('fileplane:config.json');
    expect(v).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(v).toBeLessThan(2n ** 63n);
  });
});
