// test/unit/cli/people.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli;
beforeEach(async () => {
  c = await cliWorld();
  await c.runnerEnv();
  await c.stub('curl', curlRoutes([
    ['/api/people?format=tsv', 200, 'u-1\town@x.io\towner\tactive\nu-2\tm@x.io\tmember\tactive'],
    ['/api/people/invite', 200, '{"userId":"u-3","claimUrl":"http://mb.test/claim/abc"}'],
    ['/api/people/u-2/grants/c-company', 200, '{"ok":true}'],
    ['/api/people/u-2/offboard', 200, '{"ok":true}'],
    ['/api/people/mode', 200, '{"ok":true}'],
    ['/api/sources/company', 200, '{"id":"c-eng"}'],
  ]));
});
afterEach(async () => rm(c.root, { recursive: true, force: true }));

const bodies = async () => (await c.calls('curl')).map((a) => {
  const i = a.indexOf('--data-binary');
  return [a[a.indexOf('-X') + 1], a[a.length - 1], i >= 0 ? a[i + 1] : null];
});

test('invite prints the claim url', async () => {
  const r = await c.run(['member', 'invite', 'n@x.io', '--role', 'member']);
  expect(r.stdout.trim()).toBe('http://mb.test/claim/abc');
  expect((await bodies())[0]).toEqual(['POST', 'http://mb.test/api/people/invite', '{"email":"n@x.io","role":"member"}']);
});

test('grant resolves the email to an id and sends agentReads', async () => {
  await c.run(['grant', 'm@x.io', 'c-company', '--no-agent-reads']);
  const b = await bodies();
  expect(b[1]).toEqual(['PUT', 'http://mb.test/api/people/u-2/grants/c-company', '{"agentReads":false}']);
});

test('an unknown email is an error', async () => {
  const r = await c.run(['member', 'offboard', 'nobody@x.io']);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('no such member');
});

test('mode and source add', async () => {
  await c.run(['mode', 'company']);
  const r = await c.run(['source', 'add', 'Engineering']);
  expect(r.stdout.trim()).toBe('c-eng');
  const b = await bodies();
  expect(b[0]).toEqual(['POST', 'http://mb.test/api/people/mode', '{"mode":"company"}']);
  expect(b[1]).toEqual(['POST', 'http://mb.test/api/sources/company', '{"name":"Engineering"}']);
});
