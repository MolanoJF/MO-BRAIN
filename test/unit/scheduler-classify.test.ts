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

describe('the autopilot tripwire', () => {
  const report = (installed: boolean, state: string) => ({
    installed, install_target: installed ? 'ephemeral-container' : null, state,
    disabled_reason: null, paused_reason: null, heartbeat_age_seconds: null,
    stale_after_seconds: 1800, last_log: '',
  });

  test('not installed, exit 0, is the only ok', () => {
    expect(classifyExit('autopilot-status', 0, report(false, 'not_installed'))).toBe('ok');
  });

  test('a FRESH install is a conflict even though upstream exits 0', () => {
    expect(classifyExit('autopilot-status', 0, report(true, 'fresh'))).toBe('conflict');
  });

  test('stale / never_run / paused (exit 1) and disabled (exit 2) are conflicts', () => {
    for (const s of ['stale', 'never_run', 'paused']) {
      expect(classifyExit('autopilot-status', 1, report(true, s))).toBe('conflict');
    }
    expect(classifyExit('autopilot-status', 2, report(true, 'disabled'))).toBe('conflict');
  });

  test('exit 1 or 2 with NO JSON is a usage error, not a verdict', () => {
    // OBSERVED: an unknown flag exits 1, an unknown positional exits 2, and
    // neither prints a report.
    expect(classifyExit('autopilot-status', 1, null)).toBe('failed');
    expect(classifyExit('autopilot-status', 2, null)).toBe('failed');
  });

  test('exit 0 with an unreadable report never passes vacuously', () => {
    expect(classifyExit('autopilot-status', 0, null)).toBe('failed');
    expect(classifyExit('autopilot-status', 0, { installed: false })).toBe('failed');
  });

  test('the shared exit rules still come first', () => {
    expect(classifyExit('autopilot-status', 143, null)).toBe('timeout');
    expect(classifyExit('autopilot-status', 4, null)).toBe('lock_lost');
  });
});
