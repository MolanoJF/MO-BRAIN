// test/unit/crypto.test.ts
import { describe, expect, test } from 'bun:test';
import { newToken, open, seal, sha256Hex } from '../../src/server/crypto.ts';

const KEY = 'x'.repeat(44);

describe('crypto', () => {
  test('seal and open round-trip', () => {
    const s = seal(KEY, 'gbrain-token-123');
    expect(s.startsWith('v1:')).toBe(true);
    expect(s).not.toContain('gbrain-token-123');
    expect(open(KEY, s)).toBe('gbrain-token-123');
  });

  test('two seals of the same text differ', () => {
    expect(seal(KEY, 'a')).not.toBe(seal(KEY, 'a'));
  });

  test('a different key cannot open', () => {
    expect(() => open('y'.repeat(44), seal(KEY, 'a'))).toThrow();
  });

  test('a tampered payload cannot open', () => {
    const parts = seal(KEY, 'abc').split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => open(KEY, parts.join(':'))).toThrow();
  });

  test('newToken is 43 url-safe chars and sha256Hex is stable', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
