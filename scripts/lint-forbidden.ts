#!/usr/bin/env bun
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export type Violation = { file: string; line: number; rule: string; text: string };

/** `only` restricts a rule to paths matching the regex; absent means everywhere. */
type Rule = { rule: string; re: RegExp; why: string; only?: RegExp };

const RULES: Rule[] = [
  {
    rule: 'autopilot-install',
    re: /autopilot\s+--install/,
    why: 'writes a crontab line; in a container that is a silent no-op or a duplicate-scheduler bug',
  },
  {
    rule: 'shell-string-gbrain',
    // `gbrain` must be at a COMMAND position: not preceded by / or - , and
    // followed by whitespace. Without those guards this flags every benign
    // `sh -c` that merely mentions a /srv/gbrain-home path.
    re: /["'`]\s*(sh|bash)\s*["'`]\s*,\s*["'`]-c["'`][\s\S]{0,80}(?<![\w\/-])gbrain\s/,
    why: 'G2 requires argv arrays, never shell strings',
  },
  {
    rule: 'shell-string-harness',
    // The sibling of shell-string-gbrain, and it copies that rule's
    // command-position guards verbatim: `claude` must not be preceded by / or -
    // (a /opt/harness/bin/claude path is not an invocation) and must be followed
    // by whitespace. Without them this flags every benign `sh -c` that merely
    // names the harness path.
    re: /["'`]\s*(sh|bash)\s*["'`]\s*,\s*["'`]-c["'`][\s\S]{0,80}(?<![\w\/-])claude\s/,
    why: 'G2 requires argv arrays, never shell strings; that covers claude as well as gbrain',
  },
  {
    rule: 'moving-pin',
    re: /garrytan\/gbrain#(latest|latest-stable|main|master|HEAD)\b/,
    why: 'G1 requires an exact semver pin; a moving ref is non-reproducible',
  },
  {
    rule: 'moving-harness-pin',
    // Sibling of moving-pin, for the second pinned dependency. Three ways to
    // name the harness without pinning it: a dist-tag, a bare ^/~ range, or no
    // version at all. `(?![-\w])` keeps the platform sub-packages
    // (-linux-x64, -darwin-arm64) out of it, and the Dockerfile's own
    // `@${HARNESS_VERSION}` is an exact ARG by construction -- it must not be
    // flagged, or the rule would fail the one line that IS the pin.
    re: /@anthropic-ai\/claude-code(?![-\w])(?:@(?:latest|next|stable|beta|canary|nightly|dev)\b|@[\^~]|\s*["'`]?\s*$|["'`]?\s*:\s*["'`]?(?:latest|next|stable|beta|canary|nightly|dev|\^|~))/,
    why: 'G1 requires an exact harness version; a dist-tag, a range, or no version at all is non-reproducible',
  },
  {
    rule: 'log-request-body',
    // [^)]* cannot span the ) inside json(), and a trailing \b after json()
    // never fires () then ; are both non-word). Keep all three arms.
    re: /console\.(log|info|debug|error)\([^;]*?(?:\b(?:req\.body|body)\b|await\s+req\.json\(\))/,
    why: 'S3c: a control plane that logs the body of "add source" undoes the upstream invariant',
  },
  {
    rule: 'secret-column-name',
    re: /\b(plaintext|api_key_plain|secret_value)\s*:\s*text\(/,
    why: 'S3b: secrets are envelope-encrypted; a plaintext column makes a pg_dump a credential dump',
  },
  {
    rule: 'frozen-crypto-domain',
    // D3: these three strings are HKDF domain separators, not names. Changing
    // 'brainstand-kek-v1' makes every row in `secrets` permanently
    // undecryptable — both provider keys, with no recovery. Changing either
    // gateway-token string breaks every live token mid-run. They are frozen
    // forever, including through the product rename.
    re: /Buffer\.from\(\s*['"`](?!brainstand-(?:kek-v1|gateway-token-salt|gateway-token-v1)['"`])[\w-]*-(?:kek|gateway-token)-(?:v\d+|salt)['"`]/,
    why: 'D3: HKDF domain separators are frozen forever; renaming one destroys every stored secret or every live token',
  },
  {
    rule: 'production-compose-build',
    re: /^\s{2,}build:\s*$/m,
    why: 'D2: the production compose file pulls published images; build stanzas live in docker-compose.build.yml',
    only: /compose\/docker-compose\.yml$/,
  },
];

// 'docs' is skipped deliberately: this guard protects CODE, and planning
// documents necessarily quote the very patterns they forbid.
// '.superpowers' is skipped for the same reason: it is the git-ignored
// scratch directory for the subagent-driven-development process (ledgers,
// task briefs, agent reports, review packages). It is never shipped, and
// agent reports routinely quote the rules they are reporting about.
const SKIP_DIRS = new Set(['node_modules', '.git', 'contracts', '.brainstand-tmp', 'docs', '.superpowers']);
const EXTS = ['.ts', '.tsx', '.js', '.sh', '.yml', '.yaml', '.Dockerfile', '.md'];

// Root-level HANDOFF.md is a planning document that lives outside docs/ by
// convention (it's the cold-start entry point, meant to be found immediately).
// Same rationale as the 'docs' skip above: it quotes forbidden patterns in
// order to forbid them, not to invoke them. This is a named-file exemption,
// not a blanket markdown exemption — README.md and everything else at the
// root is still linted.
const ROOT_FILE_EXEMPTIONS = new Set(['HANDOFF.md']);

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(join(dir, e.name));
    } else if (EXTS.some((x) => e.name.endsWith(x))) {
      yield join(dir, e.name);
    }
  }
}

/**
 * The per-file scanning half of the walker, split out so a rule can be tested
 * against a path and a text without a filesystem. A rule carrying `only` fires
 * only when its regex matches `path`; rules without `only` apply everywhere.
 */
export function scanText(path: string, text: string): Violation[] {
  const out: Violation[] = [];
  text.split('\n').forEach((line, i) => {
    for (const r of RULES) {
      if (r.only && !r.only.test(path)) continue;
      if (r.re.test(line)) out.push({ file: path, line: i + 1, rule: r.rule, text: line.trim() });
    }
  });
  return out;
}

export async function lintForbidden(root: string): Promise<Violation[]> {
  const out: Violation[] = [];
  for await (const file of walk(root)) {
    // The lint rules themselves contain the patterns; skip the linter and its test.
    if (file.includes('lint-forbidden')) continue;
    // Named-file exemption for root-level planning docs (see ROOT_FILE_EXEMPTIONS above).
    if (ROOT_FILE_EXEMPTIONS.has(relative(root, file))) continue;
    out.push(...scanText(file, await readFile(file, 'utf8')));
  }
  return out;
}

if (import.meta.main) {
  const violations = await lintForbidden(process.cwd());
  for (const v of violations) {
    const why = RULES.find((r) => r.rule === v.rule)?.why ?? '';
    console.error(`${v.file}:${v.line}  [${v.rule}] ${v.text}\n    ${why}`);
  }
  if (violations.length > 0) process.exit(1);
  console.log('lint:forbidden clean');
}
