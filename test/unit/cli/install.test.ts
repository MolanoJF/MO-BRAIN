// test/unit/cli/install.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, type Cli } from './harness.ts';

let c: Cli; let repo: string;
const dockerOk = `case "$1 $2" in
  "compose version") echo 2.29.1;;
  "compose ls") ${'cat "$STUB_LS" 2>/dev/null || true'};;
esac
case "$*" in
  *admin-cli.ts*bootstrap*) printf 'MOBRAIN_USER_ID=u1\\nMOBRAIN_API_KEY=mbk_abc\\nMOBRAIN_OWNER_PASSWORD=pw123\\n';;
esac
exit 0`;

beforeEach(async () => {
  c = await cliWorld();
  repo = join(c.root, 'repo');
  await mkdir(join(repo, 'compose'), { recursive: true });
  await mkdir(join(repo, 'packs'), { recursive: true });
  await writeFile(join(repo, 'compose', 'docker-compose.yml'), 'services: {}\n');
  await writeFile(join(repo, 'compose', 'docker-compose.dev.yml'), 'services: {}\n');
  await writeFile(join(c.root, 'key.txt'), 'sk-test-123456789\n');
  await c.stub('docker', dockerOk);
});
afterEach(async () => rm(c.root, { recursive: true, force: true }));

const install = (extra: string[] = [], env: Record<string, string> = {}) =>
  c.run(['install', '--owner-email', 'ada@x.io', '--openai-key-file', join(c.root, 'key.txt'), '--port', '18999', ...extra],
    { MOBRAIN_REPO: repo, ...env });

describe('install', () => {
  test('refuses when .env exists, touching nothing (Review Focus #5)', async () => {
    await writeFile(join(repo, '.env'), 'COMPOSE_PROJECT_NAME=mobrain\n');
    const r = await install();
    expect(r.code).toBe(17);
    expect(await readFile(join(repo, '.env'), 'utf8')).toBe('COMPOSE_PROJECT_NAME=mobrain\n');
    expect((await c.calls('docker')).filter((a) => a[1] !== 'version' && a[1] !== 'ls')).toEqual([]);
  });

  test('refuses when the compose project already exists', async () => {
    await writeFile(join(c.root, 'ls.txt'), 'mobrain\n');
    const r = await install([], { STUB_LS: join(c.root, 'ls.txt') });
    expect(r.code).toBe(17);
  });

  test('requires a key file or --keyless', async () => {
    const r = await c.run(['install', '--owner-email', 'a@x.io'], { MOBRAIN_REPO: repo });
    expect(r.code).toBe(64);
  });

  test('happy path: 0600 .env, ordered builds, init, packs, bootstrap, runner.env, receipt', async () => {
    const r = await install(['--project', 'mobrain-dev']);
    expect(r.code).toBe(0);
    const env = await readFile(join(repo, '.env'), 'utf8');
    expect(env).toContain('COMPOSE_PROJECT_NAME=mobrain-dev');
    expect(env).toContain('GBRAIN_VERSION=0.60.230.0');
    expect(env).toContain('OPENAI_API_KEY=sk-test-123456789');
    expect(env).toMatch(/ENCRYPTION_KEY=\S{40,}/);
    expect((await stat(join(repo, '.env'))).mode & 0o777).toBe(0o600);
    const cmds = (await c.calls('docker')).map((a) => a.filter((x) => !x.startsWith('-f') && !x.endsWith('.yml') && !x.endsWith('.env') && x !== '--env-file').join(' '));
    const order = ['compose build gbrain', 'compose build mobrain', 'compose up -d --wait postgres',
      'gbrain init --non-interactive --search-mode balanced', 'gbrain config set schema_pack mobrain-brain', 'compose up -d --wait', 'admin-cli.ts bootstrap'];
    let last = -1;
    for (const o of order) {
      const i = cmds.findIndex((x, idx) => idx > last && x.includes(o));
      expect(i).toBeGreaterThan(last);
      last = i;
    }
    expect(await readFile(join(c.home, '.config', 'mobrain', 'runner.env'), 'utf8')).toBe('MOBRAIN_URL=http://127.0.0.1:18999\nMOBRAIN_API_KEY=mbk_abc\n');
    expect(r.stdout).toContain('owner_password=pw123');
    expect(r.stdout).toContain('ui_url=http://127.0.0.1:18999');
  });

  test('--keyless installs without a key and without the embedding flag', async () => {
    const r = await c.run(['install', '--owner-email', 'a@x.io', '--keyless', '--port', '18998'], { MOBRAIN_REPO: repo });
    expect(r.code).toBe(0);
    const init = (await c.calls('docker')).find((a) => a.includes('init'))!;
    expect(init).not.toContain('--embedding-model');
  });
});
