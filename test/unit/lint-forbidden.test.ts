import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintForbidden } from '../../scripts/lint-forbidden.ts';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'bs-lint-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('lintForbidden', () => {
  test('flags autopilot --install anywhere in the repo', async () => {
    await mkdir(join(dir, 'a'), { recursive: true });
    await writeFile(join(dir, 'a', 'bad.ts'), `run("gbrain autopilot --install");\n`);
    const v = await lintForbidden(dir);
    expect(v.map((x) => x.rule)).toContain('autopilot-install');
  });

  test('flags a shell-string gbrain invocation', async () => {
    await writeFile(join(dir, 'a', 'shell.ts'), `Bun.spawn(["sh","-c","gbrain init --url "+u]);\n`);
    const v = await lintForbidden(dir);
    expect(v.map((x) => x.rule)).toContain('shell-string-gbrain');
  });

  // A path that merely CONTAINS "gbrain" is not an invocation. Without this
  // case the rule flags every legitimate `sh -c` touching /srv/gbrain-home.
  test('does not flag a shell command that only mentions a gbrain path', async () => {
    const clean = await mkdtemp(join(tmpdir(), 'bs-path-'));
    await writeFile(join(clean, 'paths.ts'),
      `composeExec('gbrain-ops', ['sh', '-c', 'touch /srv/gbrain-home/.probe && echo ok']);`);
    expect(await lintForbidden(clean)).toEqual([]);
    await rm(clean, { recursive: true, force: true });
  });

  test('flags a moving gbrain tag in a Dockerfile', async () => {
    await writeFile(join(dir, 'a', 'D.Dockerfile'), `RUN bun install -g github:garrytan/gbrain#latest-stable\n`);
    const v = await lintForbidden(dir);
    expect(v.map((x) => x.rule)).toContain('moving-pin');
  });

  test('passes a clean tree', async () => {
    const clean = await mkdtemp(join(tmpdir(), 'bs-clean-'));
    await writeFile(join(clean, 'ok.ts'), `const argv = ["init","--non-interactive"];\n`);
    expect(await lintForbidden(clean)).toEqual([]);
    await rm(clean, { recursive: true, force: true });
  });

  // Planning documents necessarily quote the patterns they forbid. This guard
  // protects CODE; without the docs skip, every plan file trips every rule.
  test('skips the docs tree entirely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-docs-'));
    await mkdir(join(root, 'docs', 'plans'), { recursive: true });
    await writeFile(join(root, 'docs', 'plans', 'p.md'),
      'Never run `gbrain autopilot --install` in a container.');
    expect(await lintForbidden(root)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});
