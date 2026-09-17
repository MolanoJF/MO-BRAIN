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

  // The harness gets the same treatment as gbrain (G2): a shell string is a
  // shell string whether the command it builds is `claude` or `gbrain`.
  test('flags a shell-string claude invocation', async () => {
    await writeFile(join(dir, 'a', 'shell-harness.ts'), `Bun.spawn(["sh","-c","claude -p "+prompt]);\n`);
    const v = await lintForbidden(dir);
    expect(v.map((x) => x.rule)).toContain('shell-string-harness');
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

  // Same near-miss for the harness rule: /opt/harness/bin/claude on a shell
  // command line is a path being tested for existence, not a command being run.
  test('does not flag a shell command that only mentions the harness path', async () => {
    const clean = await mkdtemp(join(tmpdir(), 'bs-harness-path-'));
    await writeFile(join(clean, 'paths.ts'),
      `composeExec('agent-runner', ['sh', '-c', 'test -x /opt/harness/bin/claude || exit 1']);`);
    expect(await lintForbidden(clean)).toEqual([]);
    await rm(clean, { recursive: true, force: true });
  });

  test('flags a moving gbrain tag in a Dockerfile', async () => {
    await writeFile(join(dir, 'a', 'D.Dockerfile'), `RUN bun install -g github:garrytan/gbrain#latest-stable\n`);
    const v = await lintForbidden(dir);
    expect(v.map((x) => x.rule)).toContain('moving-pin');
  });

  // The harness rule covers both halves of the same bug: a dist-tag that moves
  // under us, and no version at all.
  test('flags a harness ref that is a dist-tag or missing entirely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-harness-pin-'));
    await writeFile(join(root, 'H.Dockerfile'),
      `RUN bun install -g @anthropic-ai/claude-code@latest\nRUN bun install -g @anthropic-ai/claude-code\n`);
    const v = await lintForbidden(root);
    expect(v.map((x) => x.rule)).toEqual(['moving-harness-pin', 'moving-harness-pin']);
    await rm(root, { recursive: true, force: true });
  });

  // The one line that must never be flagged is the pin itself: an exact ARG is
  // an exact version by construction. The platform sub-packages are a different
  // package and are not the harness.
  test('does not flag the exact harness pin or the platform sub-packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-harness-pin-ok-'));
    await writeFile(join(root, 'H.Dockerfile'),
      `RUN bun install -g "@anthropic-ai/claude-code@\${HARNESS_VERSION}"\n`
      + `RUN bun install -g "@anthropic-ai/claude-code-linux-x64@2.1.274"\n`);
    expect(await lintForbidden(root)).toEqual([]);
    await rm(root, { recursive: true, force: true });
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

  // Fetch/Bun body path: the old [^)]* arm died on the ) inside json().
  test('flags logging await req.json()', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-json-'));
    await writeFile(join(root, 'log.ts'), `console.log(await req.json());\n`);
    const v = await lintForbidden(root);
    expect(v.map((x) => x.rule)).toContain('log-request-body');
    await rm(root, { recursive: true, force: true });
  });

  test('flags a plaintext secret column', async () => {
    await writeFile(join(dir, 'a', 'sch.ts'), `plaintext: text('plaintext'),\n`);
    const v = await lintForbidden(dir);
    expect(v.map((x) => x.rule)).toContain('secret-column-name');
  });
});
