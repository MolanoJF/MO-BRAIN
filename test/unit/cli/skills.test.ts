import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, type Cli } from './harness.ts';

let c: Cli; let bundle: string; let dest: string;
async function makeBundle(files: Record<string, string>) {
  const src = join(c.root, `b-${Math.random()}`);
  for (const [p, t] of Object.entries(files)) { await mkdir(join(src, p, '..'), { recursive: true }); await writeFile(join(src, p), t); }
  await Bun.spawn(['tar', '-czf', bundle, '-C', src, '.']).exited;
}
beforeEach(async () => {
  c = await cliWorld(); await c.runnerEnv();
  bundle = join(c.root, 'skills.tgz'); dest = join(c.home, 'skills');
  await c.stub('curl', `out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done; cp "${bundle}" "$out"`);
});
afterEach(async () => rm(c.root, { recursive: true, force: true }));

test('first install copies everything and writes a manifest', async () => {
  await makeBundle({ 'RESOLVER.md': 'r1', 'mobrain-collect/SKILL.md': 's1' });
  expect((await c.run(['skills', 'install', '--dir', dest])).code).toBe(0);
  expect(await readFile(join(dest, 'mobrain-collect/SKILL.md'), 'utf8')).toBe('s1');
  expect(await readFile(join(dest, '.mobrain-skills.tsv'), 'utf8')).toContain('\tmobrain-collect/SKILL.md');
});

test('re-install updates untouched files and keeps edited ones, naming them', async () => {
  await makeBundle({ 'RESOLVER.md': 'r1', 'a/SKILL.md': 'a1' });
  await c.run(['skills', 'install', '--dir', dest]);
  await writeFile(join(dest, 'a/SKILL.md'), 'my edit');
  await makeBundle({ 'RESOLVER.md': 'r2', 'a/SKILL.md': 'a2' });
  const r = await c.run(['skills', 'install', '--dir', dest]);
  expect(await readFile(join(dest, 'RESOLVER.md'), 'utf8')).toBe('r2');
  expect(await readFile(join(dest, 'a/SKILL.md'), 'utf8')).toBe('my edit');
  expect(r.stdout).toContain('kept your edited a/SKILL.md');
});
