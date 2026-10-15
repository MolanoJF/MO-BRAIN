// test/unit/cli/client.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli;
const issued = 'token=tok-SECRET\nmcp_url=http://mb.test/mcp\nname=gbrain\nexpires_at=2027-01-12T00:00:00.000Z';
beforeEach(async () => { c = await cliWorld(); await c.runnerEnv(); await c.stub('claude'); });
afterEach(async () => rm(c.root, { recursive: true, force: true }));

test('issue agent --register adds the MCP server to Claude Code and never prints the token', async () => {
  await c.stub('curl', curlRoutes([['/api/clients/issue?format=env', 200, issued]]));
  const r = await c.run(['client', 'issue', 'agent', '--register']);
  expect(r.code).toBe(0);
  expect(r.stdout + r.stderr).not.toContain('tok-SECRET');
  const calls = await c.calls('claude');
  expect(calls[0]).toEqual(['mcp', 'remove', '--scope', 'user', 'gbrain']);
  expect(calls[1]).toEqual(['mcp', 'add', '--scope', 'user', '--transport', 'http', 'gbrain', 'http://mb.test/mcp',
    '--header', 'Authorization: Bearer tok-SECRET']);
  expect(await readFile(join(c.home, '.config/mobrain/runner.env'), 'utf8')).toContain('MOBRAIN_REGISTERED=1');
});

test('issue agent without --register prints the env lines', async () => {
  await c.stub('curl', curlRoutes([['/api/clients/issue?format=env', 200, issued]]));
  expect((await c.run(['client', 'issue', 'agent'])).stdout).toContain('token=tok-SECRET');
});

test('rotate-if-expiring re-issues only inside the window, and only when registered', async () => {
  await c.stub('curl', curlRoutes([
    ['/api/clients/me?format=tsv', 200, 'agent\tp-own\t2026-10-20T00:00:00.000Z\t6\nui\tp-own\t2027-01-01T00:00:00.000Z\t79'],
    ['/api/clients/issue?format=env', 200, issued],
  ]));
  const r1 = await c.run(['client', 'rotate-if-expiring']);
  expect(r1.stderr).toContain('not registered');
  expect(await c.calls('claude')).toEqual([]);
  await c.run(['client', 'issue', 'agent', '--register']);
  const before = (await c.calls('claude')).length;
  await c.run(['client', 'rotate-if-expiring', '--days', '14']);
  expect((await c.calls('claude')).length).toBe(before + 2);
  await c.run(['client', 'rotate-if-expiring', '--days', '3']);
  expect((await c.calls('claude')).length).toBe(before + 2);
});
