import { test, expect, describe } from 'bun:test';
import { classifyExit } from '../../src/scheduler/execute.ts';

describe('exit classification', () => {
  test('zero is ok for every command', () => {
    for (const id of ['sync', 'embed', 'dream', 'doctor', 'sources-push']) {
      expect(classifyExit(id, 0, {})).toBe('ok');
    }
  });

  test('sources-push exit 5 is BLOCKED, not a generic failure', () => {
    // Upstream runPush: 5 = blocked_secrets / blocked_tracked_deny /
    // blocked_unscannable / refused_visibility.
    expect(classifyExit('sources-push', 5, { status: 'blocked_secrets' })).toBe('blocked');
    expect(classifyExit('sources-push', 5, { status: 'refused_visibility' })).toBe('refused');
  });

  test('sources-push exit 1 distinguishes a conflict from a rejected push', () => {
    expect(classifyExit('sources-push', 1, { status: 'pull_conflict' })).toBe('conflict');
    // The non-fast-forward path. Never swallowed.
    expect(classifyExit('sources-push', 1, { status: 'push_failed' })).toBe('conflict');
    expect(classifyExit('sources-push', 1, { status: 'error' })).toBe('failed');
  });

  test('exit 4 is LOCK_LOST, not an undifferentiated crash', () => {
    // Slice 0 findings V5: gbrain's supervisor defines an undocumented
    // ExitCodes.LOCK_LOST = 4 ("the queue-scoped DB lock was lost mid-run").
    // Any command that can hold a gbrain lock can surface it.
    expect(classifyExit('sync', 4, null)).toBe('lock_lost');
    expect(classifyExit('dream', 4, null)).toBe('lock_lost');
  });

  test('a SIGTERM-killed child reads as timeout, not success', () => {
    // runGbrain kills with SIGTERM on timeout; node reports the signal exit.
    expect(classifyExit('sync', 143, null)).toBe('timeout');
    expect(classifyExit('sync', -1, null)).toBe('failed');
  });

  test('anything else is a plain failure', () => {
    expect(classifyExit('doctor', 1, { status: 'blockers' })).toBe('failed');
    expect(classifyExit('doctor', 2, null)).toBe('failed');
    expect(classifyExit('sync', 2, null)).toBe('failed');
  });
});
