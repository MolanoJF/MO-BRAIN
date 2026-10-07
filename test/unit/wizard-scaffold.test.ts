import { describe, expect, mock, test } from 'bun:test';
import type { ScaffoldResult } from '../../src/control/scaffold.ts';

const ok = (sourceId = 's1'): ScaffoldResult => ({ sourceId, pack: 'p', created: ['a/README.md'], skipped: [], error: null });
const bad = (sourceId = 's1'): ScaffoldResult => ({ sourceId, pack: 'p', created: [], skipped: [], error: 'ops down' });

let script: (ScaffoldResult[] | Error)[] = [];
let calls = 0;
mock.module('../../src/control/scaffold.ts', () => ({
  scaffoldSpaces: async () => {
    const next = script[Math.min(calls++, script.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  },
}));

const { scaffoldWithRetry } = await import('../../src/control/routes/wizard.ts');
const { scaffoldProblems } = await import('../../src/console/pages/Wizard.tsx');
const run = (expected = 1) => scaffoldWithRetry('org', 'user', '', expected, { delayMs: 0 });
const reset = (s: typeof script) => { script = s; calls = 0; };

describe('scaffoldWithRetry (wizard /finish)', () => {
  test('a clean first attempt is not repeated', async () => {
    reset([[ok()]]);
    expect(await run()).toEqual([ok()]);
    expect(calls).toBe(1);
  });

  test('a transient failure is retried until the Space is scaffolded', async () => {
    reset([[bad()], new Error('connection terminated'), [ok()]]);
    expect(await run()).toEqual([ok()]);
    expect(calls).toBe(3);
  });

  test('a persistent failure is returned for the caller to surface, after 3 attempts', async () => {
    reset([[bad()]]);
    const r = await run();
    expect(r[0]!.error).toBe('ops down');
    expect(calls).toBe(3);
  });

  test('a thrown error becomes a result, never an exception', async () => {
    reset([new Error('boom')]);
    expect(await run()).toEqual([{ sourceId: '*', pack: null, created: [], skipped: [], error: 'boom' }]);
  });

  test('no Spaces back although some exist is an error, not a pass', async () => {
    reset([[]]);
    expect((await run(1))[0]!.error).toMatch(/no Spaces resolved/);
  });

  test('an already-scaffolded Space (nothing created) is a success', async () => {
    const done: ScaffoldResult = { ...ok(), created: [], skipped: ['a/README.md'] };
    reset([[done]]);
    expect(await run()).toEqual([done]);
    expect(calls).toBe(1);
  });
});

describe('scaffoldProblems (wizard notice)', () => {
  test('names each failing Space and stays empty when all went well', () => {
    expect(scaffoldProblems(undefined)).toEqual([]);
    expect(scaffoldProblems([{ sourceId: 's1', created: [], error: null }])).toEqual([]);
    expect(scaffoldProblems([
      { sourceId: 's1', created: [], error: 'ops down' },
      { sourceId: '*', created: [], error: 'boom' },
    ])).toEqual(['s1: ops down', 'Your Spaces: boom']);
  });
});
