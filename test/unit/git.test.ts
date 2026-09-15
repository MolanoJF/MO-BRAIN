import { test, expect, describe } from 'bun:test';
import { classifyLock, commitArgs } from '../../src/ops/git.ts';

describe('classifyLock', () => {
  // A lock held for seconds is a healthy concurrent write. One held for
  // minutes is a crashed process, and the difference is the whole signal.
  test('a fresh lock is not stale', () => {
    expect(classifyLock(5).staleLock).toBe(false);
  });

  test('a lock older than the threshold is stale', () => {
    expect(classifyLock(600).staleLock).toBe(true);
  });

  test('no lock at all is not stale', () => {
    expect(classifyLock(null)).toEqual({ staleLock: false, lockAgeSeconds: null });
  });
});

describe('commitArgs', () => {
  // Commit as the member, not as "the agent". This is what makes the audit
  // story real rather than "agent-runner did everything".
  test('sets author identity per invocation rather than globally', () => {
    const argv = commitArgs({ name: 'Alice Example', email: 'alice@example.test' }, 'add page');
    expect(argv.slice(0, 6)).toEqual([
      '-c', 'user.name=Alice Example', '-c', 'user.email=alice@example.test', 'commit', '-m',
    ]);
    expect(argv.at(-1)).toBe('add page');
  });

  test('keeps a message with shell metacharacters in one argv element', () => {
    const argv = commitArgs({ name: 'A', email: 'a@b.test' }, 'fix; rm -rf / #');
    expect(argv.at(-1)).toBe('fix; rm -rf / #');
    expect(argv.filter((a) => a.includes('rm -rf'))).toHaveLength(1);
  });

  test('refuses an identity containing a newline', () => {
    expect(() => commitArgs({ name: 'A\nB', email: 'a@b.test' }, 'm'))
      .toThrow('invalid git identity');
  });
});
