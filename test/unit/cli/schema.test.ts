import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli; let repo: string;
beforeEach(async () => {
  c = await cliWorld(); await c.runnerEnv();
  repo = join(c.root, 'repo');
  await mkdir(join(repo, 'compose'), { recursive: true });
  await writeFile(join(repo, 'compose', 'docker-compose.yml'), '');
  await writeFile(join(repo, '.env'), 'COMPOSE_PROJECT_NAME=mobrain-dev\nMOBRAIN_PORT=8788\n');
});
afterEach(async () => rm(c.root, { recursive: true, force: true }));

test('check exits 0 when the core lock holds and 1 with the problems when it does not', async () => {
  await c.stub('curl', curlRoutes([['/api/admin/health', 200, '{"coreLock":{"ok":true,"problems":[]}}']]));
  expect((await c.run(['schema', 'check'])).code).toBe(0);
  await c.stub('curl', curlRoutes([['/api/admin/health', 200, '{"coreLock":{"ok":false,"problems":["shadowed_type:person"]}}']]));
  const r = await c.run(['schema', 'check']);
  expect(r.code).toBe(1);
  expect(r.stdout).toContain('shadowed_type:person');
});

test('exec allows only listed gbrain schema subcommands', async () => {
  await c.stub('docker');
  expect((await c.run(['schema', 'exec', '--', 'use', 'gbrain-base'], { MOBRAIN_REPO: repo })).code).toBe(64);
  expect((await c.run(['schema', 'exec', '--', 'review-orphans', '--json'], { MOBRAIN_REPO: repo })).code).toBe(0);
  const call = (await c.calls('docker')).at(-1)!;
  expect(call.slice(-5)).toEqual(['gbrain', 'gbrain', 'schema', 'review-orphans', '--json']);
});

test('apply restores the previous pack when validation fails', async () => {
  await c.stub('docker', 'case "$*" in *"schema validate"*) exit 3;; esac; exit 0');
  await c.stub('curl', curlRoutes([['/api/admin/health', 200, '{"coreLock":{"ok":true,"problems":[]}}']]));
  const f = join(c.root, 'brain.json'); await writeFile(f, '{}');
  const r = await c.run(['schema', 'apply', f], { MOBRAIN_REPO: repo });
  expect(r.code).toBe(1);
  const calls = (await c.calls('docker')).map((a) => a.join(' '));
  expect(calls.some((x) => x.includes('pack.json.bak /srv/gbrain-home/.gbrain/schema-packs/mobrain-brain/pack.json'))).toBe(true);
  expect(calls.some((x) => x.includes('restart'))).toBe(false);
});
