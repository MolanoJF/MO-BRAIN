import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The script reads its log excerpts from the CURRENT directory (the CI job's
// workspace), so the spawn's `cwd` is the temp dir holding the fixtures. That
// makes the script path itself absolute, resolved from this test file.
const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'drift-issue-body.sh');

async function body(dir: string): Promise<string> {
  const proc = Bun.spawn(
    ['bash', SCRIPT, '0.51.0.0', 'https://example.test/runs/1', '0.50.5.0'],
    { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`drift-issue-body exited ${code}: ${stderr}`);
  return stdout;
}

describe('drift issue body', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'drift-body-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('quotes the Dockerfile gate when the suite never started', async () => {
    await writeFile(join(dir, 'build-output.txt'),
      'test -s "contracts/v0.51.0.0/operations.json"\n' +
      'operations.json missing for 0.51.0.0 — run Slice 0 first\n' +
      'ERROR: process "/bin/sh -c test -s" did not complete successfully: exit code: 1\n');
    const text = await body(dir);
    expect(text).toContain('0.51.0.0');
    expect(text).toContain('operations.json missing for 0.51.0.0');
    expect(text).toContain('Pinned-current (`0.50.5.0`) is unaffected');
    expect(text).toContain('do not move the pin');
    expect(text).not.toContain('see the run log');
  });

  test('quotes contract (fail) lines when the suite ran', async () => {
    await writeFile(join(dir, 'contract-output.txt'),
      '(pass) doctor --json\n(fail) schema lint --json reports against the active pack\n');
    await writeFile(join(dir, 'build-output.txt'), 'ERROR: should not win\n');
    const text = await body(dir);
    expect(text).toContain('(fail) schema lint --json reports against the active pack');
    expect(text).not.toContain('should not win');
  });

  test('says the excerpt is missing when no log file matched', async () => {
    const text = await body(dir);
    expect(text).toContain('no failure excerpt was captured');
  });
});
