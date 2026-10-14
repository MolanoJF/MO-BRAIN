#!/usr/bin/env bun
import { existsSync } from 'node:fs';
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
    rule: 'shell-string-gbrain-bash',
    re: /\b(sh|bash)\s+-c\s+["'][^"']*(?<![\w\/-])(gbrain|claude)\s/,
    why: 'argv arrays only, in bash too: build an array and run "${cmd[@]}"',
  },
  {
    rule: 'moving-pin',
    re: /garrytan\/gbrain#(latest|latest-stable|main|master|HEAD)\b/,
    why: 'G1 requires an exact semver pin; a moving ref is non-reproducible',
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
    re: /\b(plaintext|api_key_plain|secret_value)\s+text\b/i,
    why: 'secrets and tokens are sealed; a plaintext column makes a pg_dump a credential dump',
  },
  {
    rule: 'frozen-crypto-domain',
    // 'mobrain-kek-v1' is an HKDF domain separator. Changing it makes every
    // sealed token permanently undecryptable.
    re: /Buffer\.from\(\s*['"`](?!mobrain-kek-v1['"`])[\w-]*-kek-v\d+['"`]/,
    why: 'the HKDF domain separator is frozen forever; renaming it destroys every sealed token',
  },
];

// 'docs' is skipped deliberately: this guard protects CODE, and planning
// documents necessarily quote the very patterns they forbid.
// '.superpowers' is skipped for the same reason: it is the git-ignored
// scratch directory for the subagent-driven-development process (ledgers,
// task briefs, agent reports, review packages). It is never shipped, and
// agent reports routinely quote the rules they are reporting about.
const SKIP_DIRS = new Set(['node_modules', '.git', 'contracts', '.mobrain-tmp', 'docs', '.superpowers']);
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
      // Nested git checkouts (worktrees under .worktrees/ or
      // .claude/worktrees/, or clones) are other branches' code, linted in
      // their own checkout. A `.git` entry (file for worktrees, dir for
      // clones) marks one; never skip the root itself, only subdirectories.
      if (existsSync(join(dir, e.name, '.git'))) continue;
      yield* walk(join(dir, e.name));
    } else if (EXTS.some((x) => e.name.endsWith(x)) || dir.endsWith('/bin') || e.name.endsWith('.sql')) {
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
