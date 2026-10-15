import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli; let repo: string; let backups: string;
beforeEach(async () => {
  c = await cliWorld();
  repo = join(c.root, 'repo'); backups = join(c.root, 'backups');
  await mkdir(join(repo, 'compose'), { recursive: true });
  await writeFile(join(repo, 'compose', 'docker-compose.yml'), '');
  await writeFile(join(repo, '.env'), 'COMPOSE_PROJECT_NAME=mobrain-dev\nMOBRAIN_PORT=8788\nGBRAIN_VERSION=0.60.230.0\n');
  // pg_dump prints a fake dump; the volume tar creates the archive in the mounted /b dir.
  await c.stub('docker', `case "$*" in
  *pg_dump*) echo DUMP;;
  *"-czf /b/gbrain-home.tgz"*) for a in "$@"; do case "$a" in *:/b) : > "\${a%:/b}/gbrain-home.tgz";; esac; done;;
esac
exit 0`);
  await c.stub('git', 'echo abc123');
  await c.stub('curl', curlRoutes([['/api/health', 200, '{"ok":true}']]));
});
afterEach(async () => rm(c.root, { recursive: true, force: true }));
const env = () => ({ MOBRAIN_REPO: repo, MOBRAIN_BACKUP_DIR: backups });

test('backup writes both dumps, the volume tar, version, commit and a manifest', async () => {
  const r = await c.run(['backup'], env());
  expect(r.code).toBe(0);
  const dir = r.stdout.trim().split('\n').at(-1)!;
  expect((await readdir(dir)).sort()).toEqual(['COMMIT', 'GBRAIN_VERSION', 'MANIFEST.sha256', 'env.sha256', 'gbrain-home.tgz', 'gbrain.dump', 'mobrain.dump']);
  expect(await readFile(join(dir, 'gbrain.dump'), 'utf8')).toBe('DUMP\n');
  const tar = (await c.calls('docker')).find((a) => a.includes('tar'))!;
  expect(tar).toContain('mobrain-dev_gbrain-home:/v:ro');
});

test('backup --prune keeps the newest 7', async () => {
  const base = join(backups, 'mobrain-dev');
  for (let i = 0; i < 9; i++) await mkdir(join(base, `2026010${i}T000000Z`), { recursive: true });
  await c.run(['backup', '--prune'], env());
  expect((await readdir(base)).length).toBe(7);
});

test('restore refuses without --yes and on a version mismatch', async () => {
  const r = await c.run(['backup'], env());
  const dir = r.stdout.trim().split('\n').at(-1)!;
  expect((await c.run(['restore', dir], env())).code).toBe(64);
  await writeFile(join(dir, 'GBRAIN_VERSION'), '0.60.200.0\n');
  expect((await c.run(['restore', dir, '--yes'], env())).code).toBe(17);
});

test('restore ignores the probe P8 pg_restore errors and fails on any other', async () => {
  const ignored = `case "$*" in
  *pg_dump*) echo DUMP;;
  *"-czf /b/gbrain-home.tgz"*) for a in "$@"; do case "$a" in *:/b) : > "\${a%:/b}/gbrain-home.tgz";; esac; done;;
  *pg_restore*)
    echo 'pg_restore: error: could not execute query: ERROR:  must be owner of extension vector' >&2
    echo 'pg_restore: error: could not execute query: ERROR:  permission denied to create event trigger "auto_rls_on_create_table"' >&2
    echo 'pg_restore: error: could not execute query: ERROR:  must be owner of extension citext' >&2
    echo 'pg_restore: warning: errors ignored on restore: 2' >&2
    exit 1;;
  esac
  exit 0`;
  await c.stub('docker', ignored);
  const r = await c.run(['backup'], env());
  const dir = r.stdout.trim().split('\n').at(-1)!;
  expect((await c.run(['restore', dir, '--yes'], env())).code).toBe(0);
  await c.stub('docker', ignored.replace('must be owner of extension vector', 'relation "pages" already exists'));
  expect((await c.run(['restore', dir, '--yes'], env())).code).not.toBe(0);
});

test('upgrade backs up first, sets the pin, migrates, reinstalls packs', async () => {
  await mkdir(join(repo, 'packs'), { recursive: true });
  const r = await c.run(['upgrade', '--gbrain', '0.60.240.0'], env());
  expect(r.code).toBe(0);
  expect(await readFile(join(repo, '.env'), 'utf8')).toContain('GBRAIN_VERSION=0.60.240.0');
  const cmds = (await c.calls('docker')).map((a) => a.join(' '));
  const i = (s: string) => cmds.findIndex((x) => x.includes(s));
  expect(i('pg_dump')).toBeLessThan(i('build gbrain'));
  expect(i('apply-migrations')).toBeGreaterThan(i('build mobrain'));
  expect(i('mobrain-core.json')).toBeGreaterThan(i('apply-migrations'));
});
