import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli;
beforeEach(async () => {
  c = await cliWorld(); await c.runnerEnv();
  await c.stub('curl', curlRoutes([['/api/collectors', 200, '{"slug":"system/collectors/work-email","source":"p-own"}']]));
});
afterEach(async () => rm(c.root, { recursive: true, force: true }));

test('collector add builds the JSON body, including a tools array', async () => {
  const r = await c.run(['collector', 'add', '--title', 'Work email', '--kind', 'email', '--cadence', '2h',
    '--tools', 'mcp__claude_ai_Gmail__*,mcp__x__y', '--notes', 'Skip "promo" mail']);
  expect(r.stdout.trim()).toBe('system/collectors/work-email');
  const call = (await c.calls('curl'))[0]!;
  expect(JSON.parse(call[call.indexOf('--data-binary') + 1]!)).toEqual({
    title: 'Work email', kind: 'email', cadence: '2h', allowedTools: ['mcp__claude_ai_Gmail__*', 'mcp__x__y'],
    backfillDays: 90, notes: 'Skip "promo" mail' });
});

test('brain exec allows only listed passes', async () => {
  expect((await c.run(['brain', 'exec', '--', 'drop-everything'])).code).not.toBe(0);
});
