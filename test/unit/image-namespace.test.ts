import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The repo MoliorOS/MO-BRAIN is in the MoliorOS org, but the three images were
// first published under the personal `molanojf` account. That personal
// namespace cannot push from an org repo's GITHUB_TOKEN (HTTP 403), and GHCR
// has no redirects and cannot transfer packages, so every LIVE reference must
// move to the org namespace `molioros` (GHCR namespaces are lowercase). This
// guardrail keeps the old namespace from creeping back in.
const ROOT = join(import.meta.dir, '..', '..');

// Historical records that intentionally keep the old namespace: the CHANGELOG's
// existing entries and the SDD plans quote the personal namespace, docs/slice-*
// are the findings of record, and this test names the token it forbids.
const ALLOWLIST = [
  'CHANGELOG.md',
  'docs/slice-',
  'docs/superpowers/',
  'test/unit/image-namespace.test.ts',
];

function allowed(file: string): boolean {
  return ALLOWLIST.some((entry) => file === entry || file.startsWith(entry));
}

// A v1.0.0 `RepoDigest` pin published under the old namespace is an immutable
// historical record — release-verify.yml's three `default:` inputs and
// HANDOFF.md's digest table — that the controller replaces after the republish.
// It is not a live namespace reference, so it is exempt.
const DIGEST_PIN = /ghcr\.io\/molanojf\/[a-z0-9-]+@sha256:[0-9a-f]{64}/i;

// Narrowed to the IMAGE NAMESPACE, not the username: the GitHub account
// `MolanoJF` may still appear in a repo URL or branch name without being a
// registry namespace. The bare-token arm therefore only matches `molanojf`
// when it is not part of a `user/repo` path.
const OFFENSES: RegExp[] = [
  /ghcr\.io\/molanojf/i,
  /IMAGE_NAMESPACE[^\n]*molanojf/i,
  /:-molanojf/i,
  /(?<![A-Za-z0-9_/.-])molanojf(?![A-Za-z0-9_/-])/i,
];

function offendingLines(file: string, text: string): number[] {
  const hits: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (DIGEST_PIN.test(line)) continue;
    if (OFFENSES.some((re) => re.test(line))) hits.push(i + 1);
  }
  return hits;
}

function trackedFiles(): string[] {
  const out = Bun.spawnSync(['git', 'ls-files'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (out.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
  }
  return out.stdout.toString().split(/\r?\n/).filter(Boolean);
}

describe('image namespace', () => {
  test('no live reference to the old molanojf namespace', () => {
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      if (allowed(file)) continue;
      const buf = readFileSync(join(ROOT, file));
      if (buf.includes(0)) continue; // binary
      for (const line of offendingLines(file, buf.toString('utf8'))) {
        offenders.push(`${file}:${line}`);
      }
    }
    const message = `live references to the old molanojf image namespace:\n${offenders.join('\n')}`;
    expect(offenders, message).toEqual([]);
  });

  test('compose defaults to the molioros namespace', () => {
    const compose = readFileSync(join(ROOT, 'compose', 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('${IMAGE_NAMESPACE:-molioros}');
  });

  test('scripts/install.sh defaults to the molioros namespace', () => {
    const install = readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8');
    expect(install).toContain('${IMAGE_NAMESPACE:-molioros}');
  });
});
