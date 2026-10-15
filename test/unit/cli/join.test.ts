// test/unit/cli/join.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli;
beforeEach(async () => {
  c = await cliWorld();
  await c.stub('claude'); await c.stub('systemctl', 'exit 1'); await c.stub('loginctl', 'echo no');
  await c.stub('crontab', 'if [ "$1" = -l ]; then exit 1; else cat > /dev/null; fi');
  await c.stub('tar'); // skills bundle contents are covered by skills.test.ts
});
afterEach(async () => rm(c.root, { recursive: true, force: true }));

test('join writes runner.env, registers the agent, installs skills and timers', async () => {
  await c.stub('curl', curlRoutes([
    ['/api/clients/issue?format=env', 200, 'token=tok-1\nmcp_url=https://b.ts.net/mcp\nname=gbrain\nexpires_at=2027-01-01T00:00:00.000Z'],
  ]).replace('url="${@: -1}"', 'url="${@: -1}"; for a in "$@"; do [ "$prev" = -o ] && : > "$a"; prev=$a; done'));
  const r = await c.run(['join', '--url', 'https://b.ts.net', '--key', 'mbk_join']);
  expect(r.code).toBe(0);
  const env = await readFile(join(c.home, '.config/mobrain/runner.env'), 'utf8');
  expect(env).toContain('MOBRAIN_URL=https://b.ts.net');
  expect(env).toContain('MOBRAIN_API_KEY=mbk_join');
  expect(env).toContain('MOBRAIN_REGISTERED=1');
  expect((await c.calls('claude'))[1]).toContain('https://b.ts.net/mcp');
  expect(r.stdout).toContain('timers installed');
});
