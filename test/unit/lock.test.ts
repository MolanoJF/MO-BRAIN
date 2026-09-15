import { test, expect, describe } from 'bun:test';
import { lockKeyToBigint, mergeConfigJson } from '../../src/ops/lock.ts';

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

describe('mergeConfigJson', () => {
  test('creates a document when none exists', () => {
    expect(JSON.parse(mergeConfigJson(null, { openai_api_key: 'sk-x' })))
      .toEqual({ openai_api_key: 'sk-x' });
  });

  // The whole point of S3: a concurrent writer must not lose the other key.
  test('preserves keys it is not patching', () => {
    const current = JSON.stringify({ openai_api_key: 'sk-a', engine: 'postgres' });
    expect(JSON.parse(mergeConfigJson(current, { anthropic_api_key: 'sk-b' })))
      .toEqual({ openai_api_key: 'sk-a', engine: 'postgres', anthropic_api_key: 'sk-b' });
  });

  test('overwrites a key it is patching', () => {
    const current = JSON.stringify({ openai_api_key: 'old' });
    expect(JSON.parse(mergeConfigJson(current, { openai_api_key: 'new' })).openai_api_key)
      .toBe('new');
  });

  test('refuses to clobber a corrupt document', () => {
    expect(() => mergeConfigJson('{not json', { a: 1 }))
      .toThrow('refusing to overwrite unparseable config.json');
  });
});
