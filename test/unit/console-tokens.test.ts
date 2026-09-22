import { test, expect, describe } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Token discipline, ported from `qm/plugins/web-ui/test/css-vars.test.ts`.
 *
 * These are the checks that keep a design system from quietly rotting back
 * into what it replaced. None of them render anything — they read the console's
 * CSS and TypeScript as text — which is what makes them possible at all in a
 * repo with no DOM harness.
 *
 * The failure each one prevents:
 *
 *  1. A `var(--x)` whose property nothing defines resolves to nothing. A
 *     colour silently becomes transparent, a padding becomes zero, and the
 *     page still renders — just wrong. Nothing throws, so nobody finds out.
 *  2. A colour defined in one theme and not the other inherits across. Light
 *     mode was added in this phase and is the one nobody looks at daily, so
 *     this is the check that keeps it from rotting.
 *  3. A raw hex outside the theme blocks cannot be themed at all. Rule 3 is
 *     what stops the system drifting back to the nine hardcoded colours this
 *     port removed.
 */

const CONSOLE_DIR = join(import.meta.dir, '../../src/console');
const TOKENS_CSS = readFileSync(join(CONSOLE_DIR, 'styles/tokens.css'), 'utf8');
const STYLES_CSS = readFileSync(join(CONSOLE_DIR, 'styles.css'), 'utf8');

/** Comments in these files quote the very patterns these tests forbid — that is
 *  what makes them useful comments. Every rule below reads the declarations. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const TOKENS_CODE = stripComments(TOKENS_CSS);

/** Every `.ts`/`.tsx` under `src/console`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const TS_SOURCES: ReadonlyArray<readonly [string, string]> = sourceFiles(CONSOLE_DIR).map(
  (f) => [f.slice(CONSOLE_DIR.length + 1).replaceAll('\\', '/'), readFileSync(f, 'utf8')] as const,
);

/** `--foo: value` — a definition, not a reference. */
function definedProperties(css: string): Set<string> {
  const defined = new Set<string>();
  for (const m of css.matchAll(/(?:^|[\s;{(])(--[A-Za-z0-9-]+)\s*:/g)) defined.add(m[1]!);
  return defined;
}

/** `var(--foo)` with no comma, i.e. no fallback to save it. */
function noFallbackReferences(text: string): string[] {
  return [...text.matchAll(/var\(\s*(--[A-Za-z0-9-]+)\s*\)/g)].map((m) => m[1]!);
}

/** The body of a top-level `:root` / `:root.dark` block. */
function themeBlocks(css: string, selector: string): string[] {
  const escaped = selector.replace('.', '\\.');
  return [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]!);
}

function tokensIn(blocks: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const block of blocks) {
    for (const m of block.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) found.set(m[1]!, m[2]!.trim());
  }
  return found;
}

/** A value that paints a colour, as opposed to a length or a font stack. */
function isColorValue(value: string): boolean {
  return /#[0-9a-fA-F]{3,8}\b|oklch\(|rgba?\(|color-mix\(/.test(value);
}

describe('rule 1: every no-fallback var() names a property something defines', () => {
  // Tailwind's own generated properties (`--tw-*`, `--spacing`, `--color-*`
  // from the @theme bridge) are all declared in the CSS this reads, so the
  // defined set is built from the same two files the references come from.
  const defined = new Set([...definedProperties(TOKENS_CSS), ...definedProperties(STYLES_CSS)]);

  test('styles.css references nothing undefined', () => {
    const dead = [...new Set(noFallbackReferences(STYLES_CSS))].filter((v) => !defined.has(v));
    expect(dead).toEqual([]);
  });

  test('tokens.css references nothing undefined', () => {
    const dead = [...new Set(noFallbackReferences(TOKENS_CSS))].filter((v) => !defined.has(v));
    expect(dead).toEqual([]);
  });

  test('the TypeScript sources reference nothing undefined either', () => {
    // qm scans only its CSS for references. Mobrain must scan the TS too:
    // `editor/theme.ts` builds a CodeMirror theme out of `var(--color-*)`
    // strings, and renaming `--color-accent` to `--color-cta` broke all 12 of
    // its references at once — invisibly, because a dead var() in CodeMirror
    // just paints nothing. A CSS-only scan would have passed that commit.
    const dead: string[] = [];
    for (const [name, source] of TS_SOURCES) {
      for (const ref of new Set(noFallbackReferences(source))) {
        if (!defined.has(ref)) dead.push(`${name}: ${ref}`);
      }
    }
    expect(dead).toEqual([]);
  });
});

describe('rule 2: light and dark define the same colours', () => {
  const light = tokensIn(themeBlocks(TOKENS_CSS, ':root'));
  const dark = tokensIn(themeBlocks(TOKENS_CSS, ':root.dark'));

  test('both theme blocks were actually found', () => {
    // A guard on the guard: if the block regex stopped matching, every
    // assertion below would compare two empty maps and pass vacuously.
    expect(light.size).toBeGreaterThan(15);
    expect(dark.size).toBeGreaterThan(15);
  });

  test('every colour defined in light is redefined in dark', () => {
    const missing = [...light].filter(([k, v]) => isColorValue(v) && !dark.has(k)).map(([k]) => k);
    expect(missing).toEqual([]);
  });

  test('every colour defined in dark is defined in light', () => {
    const missing = [...dark].filter(([k, v]) => isColorValue(v) && !light.has(k)).map(([k]) => k);
    expect(missing).toEqual([]);
  });

  test('the two blocks actually differ — a theme that copies the other is not a theme', () => {
    const differing = [...light].filter(([k, v]) => isColorValue(v) && dark.get(k) !== v);
    expect(differing.length).toBeGreaterThan(8);
  });
});

describe('rule 3: no colour literal lives outside the theme blocks', () => {
  /** Strips comments and the `:root` / `:root.dark` bodies, leaving the CSS
   *  that is *not* allowed to name a colour directly. */
  function outsideThemeBlocks(css: string): string {
    return css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(?:^|\n):root(?:\.dark)?\s*\{[^}]*\}/g, '');
  }

  test('tokens.css names colours only inside :root and :root.dark', () => {
    const rest = outsideThemeBlocks(TOKENS_CSS);
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(rest.match(/oklch\(/g)).toBeNull();
  });

  test('styles.css names no colour at all — every one of its colours is a token', () => {
    const rest = outsideThemeBlocks(STYLES_CSS);
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(rest.match(/oklch\(/g)).toBeNull();
  });
});

describe('the bridge itself: @theme inline, not @theme', () => {
  test('the Tailwind bridge is declared inline', () => {
    // This one line is the whole port. Plain `@theme` copies each declared
    // value into every generated utility, which is exactly why the previous
    // `@theme { --color-bg: #0b0c0e }` made the console un-themeable: the
    // literal was baked into `.bg-bg`, so redefining anything at runtime
    // changed nothing. Losing the `inline` keyword would silently restore
    // that, and every test above would still pass.
    expect(TOKENS_CODE).toContain('@theme inline');
    expect(TOKENS_CODE).not.toMatch(/@theme\s*\{/);
  });

  test('every bridge entry points at a tier-1 token rather than a literal', () => {
    const block = TOKENS_CSS.match(/@theme inline\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(block.length).toBeGreaterThan(0);
    const colours = [...block.matchAll(/(--color-[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)];
    expect(colours.length).toBeGreaterThan(10);
    const literal = colours.filter(([, , value]) => !value!.trim().startsWith('var(')).map(([, k]) => k!);
    expect(literal).toEqual([]);
  });
});
