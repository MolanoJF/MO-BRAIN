import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli;
const due = (mode = 'incremental', slug = 'system/collectors/mail', source = 'p-own') =>
  `${slug}\t${source}\temail\tmcp__claude_ai_Gmail__*\tsonnet\t1200\t${mode}`;
const routes = (dueBody: string) => curlRoutes([
  ['/api/clients/me?format=tsv', 200, 'agent\tp-own\t2027-01-01T00:00:00.000Z\t80'],
  ['/api/runner/due', 200, dueBody],
  ['/api/runner/start', 200, '{"runId":"run-1"}'],
  ['/api/runner/finish', 200, '{"ok":true}'],
]);
const finishBody = async () => {
  const call = (await c.calls('curl')).filter((a) => a.at(-1)!.endsWith('/api/runner/finish')).at(-1)!;
  return JSON.parse(call[call.indexOf('--data-binary') + 1]!);
};

beforeEach(async () => { c = await cliWorld(); await c.runnerEnv(); });
afterEach(async () => rm(c.root, { recursive: true, force: true }));

describe('collect', () => {
  test('MOBRAIN_MCP_NAME renames the brain server the headless run may use', async () => {
    await c.stub('curl', routes(due()));
    await c.stub('claude', 'echo "MOBRAIN_STATUS: ok"');
    const r = await c.run(['collect', '--due'], { MOBRAIN_MCP_NAME: 'gbrain-dev' });
    expect(r.code).toBe(0);
    const [call] = await c.calls('claude');
    expect(call![call!.indexOf('--allowedTools') + 1]).toBe('mcp__gbrain-dev__*,mcp__claude_ai_Gmail__*');
    expect(call![1]).toContain('gbrain-dev MCP server');
  });

  test('nothing due', async () => {
    await c.stub('curl', routes(''));
    const r = await c.run(['collect', '--due']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('nothing due');
  });

  test('runs claude headless with gbrain + the collector tools, then reports ok and the summary', async () => {
    await c.stub('curl', routes(due()));
    await c.stub('claude', 'echo "working"; echo "MOBRAIN_STATUS: ok"; echo "MOBRAIN_SUMMARY: read 3, wrote 2"');
    const r = await c.run(['collect', '--due']);
    expect(r.code).toBe(0);
    const [call] = await c.calls('claude');
    expect(call![0]).toBe('-p');
    expect(call![1]).toContain('mobrain-collect');
    expect(call![1]).toContain('system/collectors/mail');
    expect(call!.slice(2)).toEqual(['--allowedTools', 'mcp__gbrain__*,mcp__claude_ai_Gmail__*', '--output-format', 'text', '--model', 'sonnet']);
    expect(await finishBody()).toMatchObject({ runId: 'run-1', status: 'ok', exitCode: 0, summary: 'read 3, wrote 2' });
  });

  test('no status line, a non-zero exit, and a timeout are reported as error, error, timeout', async () => {
    await c.stub('curl', routes(due()));
    await c.stub('claude', 'echo "forgot the contract"');
    await c.run(['collect', '--due']);
    expect((await finishBody()).status).toBe('error');

    await c.stub('claude', 'echo boom; exit 3');
    await c.run(['collect', '--due']);
    expect((await finishBody()).status).toBe('error');

    await c.stub('curl', routes(due().replace('\t1200\t', '\t1\t')));
    await c.stub('claude', 'sleep 5');
    await c.run(['collect', '--due']);
    expect((await finishBody()).status).toBe('timeout');
  });

  test('a company collector also allows that source\'s company MCP server', async () => {
    await c.stub('curl', routes(due('incremental', 'system/collectors/drive', 'c-company')));
    await c.stub('claude', 'echo "MOBRAIN_STATUS: ok"');
    await c.run(['collect', '--due']);
    const [call] = await c.calls('claude');
    expect(call![call!.indexOf('--allowedTools') + 1]).toBe('mcp__gbrain__*,mcp__gbrain-company-c-company__*,mcp__claude_ai_Gmail__*');
  });

  test('a held lock skips the collector without starting a run', async () => {
    await c.stub('curl', routes(due()));
    await c.stub('claude', 'echo "MOBRAIN_STATUS: ok"');
    const lock = join(c.home, '.local/state/mobrain/locks/system_collectors_mail.lock.d');
    await Bun.spawn(['mkdir', '-p', lock]).exited;
    const r = await c.run(['collect', '--due']);
    expect(r.stdout).toContain('already running');
    expect((await c.calls('curl')).some((a) => a.at(-1)!.endsWith('/api/runner/start'))).toBe(false);
  });

  test('a lock older than the timeout belongs to a dead run, so the collector is due again', async () => {
    await c.stub('curl', routes(due()));
    await c.stub('claude', 'echo "MOBRAIN_STATUS: ok"');
    const lock = join(c.home, '.local/state/mobrain/locks/system_collectors_mail.lock.d');
    await Bun.spawn(['mkdir', '-p', lock]).exited;
    await Bun.spawn(['touch', '-d', '2 hours ago', lock]).exited;
    const r = await c.run(['collect', '--due']);
    expect(r.stdout).not.toContain('already running');
    expect((await c.calls('curl')).some((a) => a.at(-1)!.endsWith('/api/runner/start'))).toBe(true);
    expect((await finishBody()).status).toBe('ok');
  });

  test('one collector by slug, forced into backfill, keeps a log file', async () => {
    await c.stub('curl', routes(due()));
    await c.stub('claude', 'echo "MOBRAIN_STATUS: partial"');
    await c.run(['collect', 'system/collectors/mail', '--backfill']);
    const [call] = await c.calls('claude');
    expect(call![1]).toContain('mode: backfill');
    expect((await c.calls('curl')).some((a) => a.at(-1)!.includes('/api/runner/due?slug=system%2Fcollectors%2Fmail'))).toBe(true);
    expect((await readdir(join(c.home, '.local/state/mobrain/collect/system_collectors_mail'))).length).toBe(1);
    expect((await finishBody()).status).toBe('partial');
  });

  test('a collector with no model runs without --model and keeps its own timeout', async () => {
    await c.stub('curl', routes(due().replace('\tsonnet\t', '\t\t')));
    await c.stub('claude', 'echo "MOBRAIN_STATUS: ok"');
    const r = await c.run(['collect', '--due']);
    expect(r.code).toBe(0);
    const [call] = await c.calls('claude');
    expect(call!.slice(2)).toEqual(['--allowedTools', 'mcp__gbrain__*,mcp__claude_ai_Gmail__*', '--output-format', 'text']);
    expect(await finishBody()).toMatchObject({ status: 'ok', exitCode: 0 });
  });

  test('--due inside the rotation window re-issues the agent token and re-registers the harness MCP', async () => {
    await c.stub('curl', curlRoutes([
      ['/api/clients/me?format=tsv', 200, 'agent\tp-own\t2026-10-20T00:00:00.000Z\t6'],
      ['/api/clients/issue?format=env', 200, 'token=tok-NEW\nmcp_url=http://mb.test/mcp\nname=gbrain\nexpires_at=2027-01-12T00:00:00.000Z'],
      ['/api/runner/due', 200, due()],
      ['/api/runner/start', 200, '{"runId":"run-1"}'],
      ['/api/runner/finish', 200, '{"ok":true}'],
    ]));
    await c.stub('claude', 'echo "MOBRAIN_STATUS: ok"');
    const r = await c.run(['collect', '--due'], { MOBRAIN_REGISTERED: '1' });
    expect(r.code).toBe(0);
    const claude = await c.calls('claude');
    expect(claude[1]).toEqual(['mcp', 'add', '--scope', 'user', '--transport', 'http', 'gbrain', 'http://mb.test/mcp',
      '--header', 'Authorization: Bearer tok-NEW']);
    expect(claude.some((a) => a[0] === '-p')).toBe(true);
    expect((await finishBody()).status).toBe('ok');
  });

  test('a failed token rotation warns and the due cycle still runs', async () => {
    await c.stub('curl', curlRoutes([
      ['/api/clients/me?format=tsv', 200, 'agent\tp-own\t2026-10-20T00:00:00.000Z\t6'],
      ['/api/clients/issue?format=env', 500, '{"error":"rotation_is_down"}'],
      ['/api/runner/due', 200, due()],
      ['/api/runner/start', 200, '{"runId":"run-1"}'],
      ['/api/runner/finish', 200, '{"ok":true}'],
    ]));
    await c.stub('claude', 'echo "MOBRAIN_STATUS: ok"');
    const r = await c.run(['collect', '--due'], { MOBRAIN_REGISTERED: '1' });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('rotation failed');
    expect((await finishBody()).status).toBe('ok');
  });
});
