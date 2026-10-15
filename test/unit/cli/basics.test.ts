// test/unit/cli/basics.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli;
beforeEach(async () => { c = await cliWorld(); });
afterEach(async () => rm(c.root, { recursive: true, force: true }));

async function stackHost(project = 'mobrain-dev') {
  const repo = join(c.root, 'repo');
  await mkdir(join(repo, 'compose'), { recursive: true });
  await writeFile(join(repo, 'compose', 'docker-compose.yml'), 'services: {}\n');
  await writeFile(join(repo, 'compose', 'docker-compose.dev.yml'), 'services: {}\n');
  await writeFile(join(repo, '.env'), `COMPOSE_PROJECT_NAME=${project}\nMOBRAIN_PORT=8788\nGBRAIN_VERSION=0.60.230.0\n`);
  return repo;
}

describe('basics', () => {
  test('no command prints usage and exits 64', async () => {
    const r = await c.run([]);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain('usage: mobrain');
  });

  test('stack verbs pass through to docker compose with the dev overlay for mobrain-dev', async () => {
    const repo = await stackHost();
    await c.stub('docker');
    await c.run(['ps'], { MOBRAIN_REPO: repo });
    const [call] = await c.calls('docker');
    expect(call).toEqual(['compose', '--env-file', join(repo, '.env'), '-f', join(repo, 'compose/docker-compose.yml'),
      '-f', join(repo, 'compose/docker-compose.dev.yml'), 'ps']);
  });

  test('down refuses volumes outside mobrain-dev', async () => {
    const repo = await stackHost('mobrain-molior');
    await c.stub('docker');
    const r = await c.run(['down', '-v'], { MOBRAIN_REPO: repo });
    expect(r.code).toBe(17);
    expect(await c.calls('docker')).toEqual([]);
  });

  test('down -v refuses ambient COMPOSE_PROJECT_NAME=mobrain-molior', async () => {
    const repo = await stackHost('mobrain-dev');
    await c.stub('docker');
    const r = await c.run(['down', '-v'], { MOBRAIN_REPO: repo, COMPOSE_PROJECT_NAME: 'mobrain-molior' });
    expect(r.code).toBe(17);
    expect(r.stderr).toContain('refusing to delete volumes');
    expect(await c.calls('docker')).toEqual([]);
  });

  test('down -v refuses -p mobrain-molior even when the env file says mobrain-dev', async () => {
    const repo = await stackHost('mobrain-dev');
    await c.stub('docker');
    for (const args of [
      ['down', '-v', '-p', 'mobrain-molior'],
      ['down', '-v', '-p=mobrain-molior'],
      ['down', '-v', '-pmobrain-molior'],
      ['down', '-v', '--project', 'mobrain-molior'],
      ['down', '-v', '--project=mobrain-molior'],
      ['down', '-v', '--project-name', 'mobrain-molior'],
      ['down', '-v', '--project-name=mobrain-molior'],
    ]) {
      const r = await c.run(args, { MOBRAIN_REPO: repo });
      expect(r.code).toBe(17);
      expect(r.stderr).toContain('mobrain-molior');
      expect(await c.calls('docker')).toEqual([]);
    }
  });

  test('down -v refuses an allowlisted project flag that differs from the env file', async () => {
    const repo = await stackHost('mobrain-molior');
    await c.stub('docker');
    const r = await c.run(['down', '-v', '-p', 'mobrain-dev'], { MOBRAIN_REPO: repo });
    expect(r.code).toBe(17);
    expect(r.stderr).toContain('refusing to delete volumes');
    expect(await c.calls('docker')).toEqual([]);
  });

  test('down refuses --volumes=true and -v=true on a molior env file', async () => {
    const repo = await stackHost('mobrain-molior');
    await c.stub('docker');
    for (const args of [['down', '--volumes=true'], ['down', '-v=true'], ['down', '--volumes=false']]) {
      const r = await c.run(args, { MOBRAIN_REPO: repo });
      expect(r.code).toBe(17);
      expect(r.stderr).toContain('refusing to delete volumes');
      expect(await c.calls('docker')).toEqual([]);
    }
  });

  test('down -v on mobrain-dev still calls docker compose', async () => {
    const repo = await stackHost('mobrain-dev');
    await c.stub('docker');
    const r = await c.run(['down', '-v'], { MOBRAIN_REPO: repo });
    expect(r.code).toBe(0);
    const [call] = await c.calls('docker');
    expect(call).toEqual(['compose', '--env-file', join(repo, '.env'), '-f', join(repo, 'compose/docker-compose.yml'),
      '-f', join(repo, 'compose/docker-compose.dev.yml'), 'down', '-v']);
  });

  test('stack commands refuse off a stack host', async () => {
    const r = await c.run(['ps']);
    expect(r.code).toBe(17);
    expect(r.stderr).toContain('stack host');
  });

  test('status: 0 when healthy, 1 when degraded, 2 when unreachable', async () => {
    await c.runnerEnv();
    await c.stub('curl', curlRoutes([['/api/health', 200, '{"ok":true}']]));
    expect((await c.run(['status'])).code).toBe(0);
    await c.stub('curl', curlRoutes([['/api/health', 503, '{"ok":false}']]));
    expect((await c.run(['status'])).code).toBe(1);
    await c.stub('curl', 'exit 7');
    expect((await c.run(['status'])).code).toBe(2);
  });
});
