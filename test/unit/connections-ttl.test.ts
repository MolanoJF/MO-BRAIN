import { test, expect } from 'bun:test';
import { compileConnection } from '../../src/contracts/compile.ts';
import { connectionClass } from '../../src/control/harness.ts';

// Mirrors connections.ts::compileFrom's policy in isolation, since compileFrom
// itself needs a live DB (loadSpaces) to exercise end to end — that path is
// covered by the contract test in Task 10.
function ttlFor(harness: string, explicit: number | undefined): number {
  const MANUAL_HARNESS_TOKEN_TTL = 30 * 24 * 60 * 60;
  const tokenTtl = explicit ?? (connectionClass(harness) === 'manual' ? MANUAL_HARNESS_TOKEN_TTL : undefined);
  return compileConnection(
    { role: 'member' },
    { sourceId: 'src', slug: 'space' },
    [],
    { tokenTtl },
  ).tokenTtl;
}

test('manual-class harness with no explicit TTL gets 30 days', () => {
  expect(ttlFor('generic', undefined)).toBe(30 * 24 * 60 * 60);
});

test('auto-install harness with no explicit TTL keeps the compiler default', () => {
  expect(ttlFor('claude-code', undefined)).toBe(3600);
});

test('an explicit tokenTtl always wins', () => {
  expect(ttlFor('generic', 120)).toBe(120);
});
