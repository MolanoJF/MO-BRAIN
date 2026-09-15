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

  // The gate must still bite for real code: the docs/HANDOFF/.superpowers
  // exemptions must never leak into an actual shell script.
  test('still flags autopilot --install in a real .sh file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-sh-'));
    await writeFile(join(root, 'deploy.sh'), `#!/usr/bin/env bash\ngbrain autopilot --install\n`);
    const v = await lintForbidden(root);
    expect(v.map((x) => x.rule)).toContain('autopilot-install');
    await rm(root, { recursive: true, force: true });
  });

  // .superpowers/ is the git-ignored SDD scratch directory (ledgers, task
  // briefs, agent reports). Agent reports routinely quote the rules they are
  // reporting about, so this must be skipped the same way docs/ is.
  test('skips the .superpowers tree entirely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-superpowers-'));
    await mkdir(join(root, '.superpowers', 'sdd', 'task'), { recursive: true });
    await writeFile(join(root, '.superpowers', 'sdd', 'task', 'report.md'),
      'Confirmed: the code does not run `gbrain autopilot --install`.');
    expect(await lintForbidden(root)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  // HANDOFF.md is exempt only at the repo root — a named-file exemption, not
  // a blanket markdown carve-out. A same-named file elsewhere must still be
  // linted, and it isn't enough to just match the basename.
  test('exempts root-level HANDOFF.md but still flags a nested HANDOFF.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-handoff-'));
    await writeFile(join(root, 'HANDOFF.md'),
      "- Don't run `gbrain autopilot --install` in a container — lint:forbidden will catch it.\n");
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(join(root, 'sub', 'HANDOFF.md'), 'gbrain autopilot --install\n');
    const v = await lintForbidden(root);
    expect(v).toHaveLength(1);
    expect(v[0]!.file).toBe(join(root, 'sub', 'HANDOFF.md'));
    await rm(root, { recursive: true, force: true });
  });

  // The HANDOFF.md exemption must not widen into a blanket root-level
  // markdown exemption: README.md (and anything else) at the root is still linted.
  test('does not exempt other root-level markdown files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-readme-'));
    await writeFile(join(root, 'README.md'), 'gbrain autopilot --install\n');
    const v = await lintForbidden(root);
    expect(v.map((x) => x.rule)).toContain('autopilot-install');
    await rm(root, { recursive: true, force: true });
  });

  test('flags logging a request body', async () => {
    await writeFile(join(dir, 'a', 'log.ts'), `console.log("add source", req.body);\n`);
    const v = await lintForbidden(dir);
    expect(v.map((x) => x.rule)).toContain('log-request-body');
  });

  test('flags a plaintext secret column', async () => {
    await writeFile(join(dir, 'a', 'sch.ts'), `plaintext: text('plaintext'),\n`);
    const v = await lintForbidden(dir);
    expect(v.map((x) => x.rule)).toContain('secret-column-name');
  });
});
