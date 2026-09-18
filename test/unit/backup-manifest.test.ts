import { describe, expect, test } from 'bun:test';
import { classifyQuiesce } from '../../scripts/backup.ts';

const stub = (kind: 'http' | 'relay') => ({ kind } as const);

describe('classifyQuiesce', () => {
  test('a supervisor that is not running is a VERIFIED quiesce', () => {
    expect(classifyQuiesce({ running: false, workers: [] }, null, stub('relay')))
      .toEqual({ quiesced: 'verified', quiesceLane: 'relay' });
  });

  test('a supervisor still running is a FAILED quiesce, not a warning', () => {
    expect(classifyQuiesce({ running: true, workers: [{}] }, null, stub('relay')).quiesced)
      .toBe('failed');
  });

  // The bug, pinned by name: scripts/backup.ts:108 `catch { quiesced = true }`.
  test('a probe that threw is UNVERIFIED — never verified', () => {
    const err = new Error('fetch failed: getaddrinfo ENOTFOUND gbrain-ops');
    expect(classifyQuiesce(null, err, stub('http')))
      .toEqual({ quiesced: 'unverified', quiesceLane: null });
  });
});
