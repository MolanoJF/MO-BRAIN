#!/usr/bin/env bun
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Violation = { file: string; line: number; rule: string; text: string };

const RULES: { rule: string; re: RegExp; why: string }[] = [
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
    rule: 'moving-pin',
    re: /garrytan\/gbrain#(latest|latest-stable|main|master|HEAD)\b/,
    why: 'G1 requires an exact semver pin; a moving ref is non-reproducible',
  },
];

// 'docs' is skipped deliberately: this guard protects CODE, and planning
// documents necessarily quote the very patterns they forbid.
const SKIP_DIRS = new Set(['node_modules', '.git', 'contracts', '.brainstand-tmp', 'docs']);
const EXTS = ['.ts', '.tsx', '.js', '.sh', '.yml', '.yaml', '.Dockerfile', '.md'];

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

export async function lintForbidden(root: string): Promise<Violation[]> {
  const out: Violation[] = [];
  for await (const file of walk(root)) {
    // The lint rules themselves contain the patterns; skip the linter and its test.
    if (file.includes('lint-forbidden')) continue;
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((text, i) => {
      for (const r of RULES) if (r.re.test(text)) out.push({ file, line: i + 1, rule: r.rule, text: text.trim() });
    });
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
