import { test, expect, describe } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Token discipline, ported from `qm/plugins/web-ui/test/css-vars.test.ts`.
 *
 * These are the checks that keep a design system from quietly rotting back
 * into what it replaced. None of them render anything — they read the console's
 * CSS and TypeScript as text — which is what makes them possible at all in a
 * repo with no DOM harness.
 *
 * Every theme is a file in `styles/themes/`, and rules 2, 3 and 5 run against
 * each one. A theme that leaves a colour unpaired in dark mode, or that is
 * missing a token another theme defines, fails here rather than on a screen.
 *
 * The failure each one prevents:
 *
 *  1. A `var(--x)` whose property nothing defines resolves to nothing. A
 *     colour silently becomes transparent, a padding becomes zero, and the
 *     page still renders — just wrong. Nothing throws, so nobody finds out.
 *  2. A colour defined in one theme block and not the other inherits across.
 *     Light mode was added in this phase and is the one nobody looks at daily,
 *     so this is the check that keeps it from rotting.
 *  3. A raw hex outside the theme blocks cannot be themed at all. Rule 3 is
 *     what stops the system drifting back to the nine hardcoded colours this
 *     port removed.
 *  4. A `--color-*` that `tokens.css` names but the BUNDLE never emits. Rules
 *     1-3 read source text, so they cannot see this one at all. Rule 4 builds.
 *  5. A theme missing a token another theme defines. Swapping the import would
 *     then leave that token resolving to nothing, on the screens that read it.
 *  6. A corner radius written as a literal. The radius is what a theme changes,
 *     so a literal corner keeps the old shape while everything else moves.
 */

const CONSOLE_DIR = join(import.meta.dir, '../../src/console');
const STYLES_DIR = join(CONSOLE_DIR, 'styles');
const TOKENS_CSS = readFileSync(join(STYLES_DIR, 'tokens.css'), 'utf8');
const STYLES_CSS = readFileSync(join(CONSOLE_DIR, 'styles.css'), 'utf8');

/** Comments in these files quote the very patterns these tests forbid — that is
 *  what makes them useful comments. Every rule below reads the declarations. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const TOKENS_CODE = stripComments(TOKENS_CSS);

/** Every theme file, by name, with its comments stripped. */
const THEMES: ReadonlyArray<{ name: string; css: string }> = readdirSync(join(STYLES_DIR, 'themes'))
  .filter((f) => f.endsWith('.css'))
  .sort()
  .map((f) => ({ name: f, css: stripComments(readFileSync(join(STYLES_DIR, 'themes', f), 'utf8')) }));

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

/** Strips comments and the `:root` / `:root.dark` bodies, leaving the CSS that
 *  is *not* allowed to name a colour directly. */
function outsideThemeBlocks(css: string): string {
  return css.replace(/(?:^|\n):root(?:\.dark)?\s*\{[^}]*\}/g, '');
}

/** A `.ts`/`.tsx` source with its comments removed, so a rule can read only the code. */
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('rule 1: every no-fallback var() names a property something defines', () => {
  // Tailwind's own generated properties (`--tw-*`, `--spacing`, `--color-*`
  // from the @theme bridge) are all declared in the CSS this reads, so the
  // defined set is built from the same files the references come from. Every
  // theme file is one of those sources: it is where the tier-1 values live.
  const defined = new Set([
    ...definedProperties(TOKENS_CSS),
    ...definedProperties(STYLES_CSS),
    ...THEMES.flatMap((t) => [...definedProperties(t.css)]),
  ]);

  test('styles.css references nothing undefined', () => {
    const dead = [...new Set(noFallbackReferences(STYLES_CSS))].filter((v) => !defined.has(v));
    expect(dead).toEqual([]);
  });

  test('tokens.css references nothing undefined', () => {
    const dead = [...new Set(noFallbackReferences(TOKENS_CSS))].filter((v) => !defined.has(v));
    expect(dead).toEqual([]);
  });

  test('every theme file references nothing undefined', () => {
    const dead = THEMES.flatMap((t) =>
      [...new Set(noFallbackReferences(t.css))].filter((v) => !defined.has(v)).map((v) => `${t.name}: ${v}`),
    );
    expect(dead).toEqual([]);
  });

  test('the TypeScript sources reference nothing undefined either', () => {
    // qm scans only its CSS for references. Mo-brain must scan the TS too:
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

for (const theme of THEMES) {
  describe(`rule 2 (${theme.name}): light and dark define the same colours`, () => {
    const light = tokensIn(themeBlocks(theme.css, ':root'));
    const dark = tokensIn(themeBlocks(theme.css, ':root.dark'));

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
}

describe('rule 3: no colour literal lives outside the theme blocks', () => {
  test('tokens.css names colours nowhere — the theme files own every one', () => {
    const rest = outsideThemeBlocks(TOKENS_CODE);
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(rest.match(/oklch\(/g)).toBeNull();
    expect(rest.match(/rgba?\(/g)).toBeNull();
  });

  test('styles.css names no colour at all — every one of its colours is a token', () => {
    const rest = outsideThemeBlocks(stripComments(STYLES_CSS));
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(rest.match(/oklch\(/g)).toBeNull();
    expect(rest.match(/rgba?\(/g)).toBeNull();
  });

  for (const theme of THEMES) {
    test(`${theme.name} names colours only inside :root and :root.dark`, () => {
      // @font-face and the other declarations outside the value blocks name a
      // url or a family, never a colour. Any colour found here is a leak.
      const rest = outsideThemeBlocks(theme.css);
      expect(rest.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
      expect(rest.match(/oklch\(/g)).toBeNull();
      expect(rest.match(/rgba?\(/g)).toBeNull();
    });
  }
});

describe('rule 4: every --color-* a .ts/.tsx reads survives into the built CSS', () => {
  /**
   * The hole rule 1 cannot see.
   *
   * Rule 1 calls a token "defined" because `tokens.css` writes its name. But
   * `@theme inline` does not put a theme variable in the bundle just for being
   * declared — Tailwind emits one only when something it SCANS uses it, and
   * `src/console/editor/theme.ts` builds its CodeMirror theme out of
   * `var(--color-*)` strings handed to CodeMirror at runtime, which is outside
   * the CSS entirely.
   *
   * Today those references survive because Tailwind's source detection reaches
   * the `.ts` files and emits each one it sees. What that means is that the
   * console's syntax colours depend on a detection step nothing asserts: narrow
   * `@source`, move the editor out of the scanned root, or let the directory
   * fall under a gitignore rule, and every one of them resolves to nothing.
   * CodeMirror paints a dead `var()` as no colour at all and throws nothing, so
   * the editor goes monochrome and every text-scanning rule above still passes.
   *
   * This is deliberately written against whatever the sources happen to
   * reference rather than against a list, so it keeps holding while
   * `editor/theme.ts` is being edited and keeps holding for the next file that
   * reads a token from TypeScript.
   */
  const REPO = join(import.meta.dir, '../..');
  /** Relative, because vite resolves `--outDir` against its own `root`
   *  (`src/console`) exactly as `vite.config.ts` does. */
  const OUT_REL = '../../dist/console-token-check';
  const OUT_DIR = join(REPO, 'dist/console-token-check');

  /** Built once and reused: this is the only test in `test/unit` that shells
   *  out, and a second build would double the suite's cost for nothing. */
  let cached: string | null = null;
  const builtCss = (): string => (cached ??= buildCss());

  function buildCss(): string {
    // Vite's own bin, run by this runtime, with no shell in between: the repo
    // path contains a space, and a shell would hand vite two arguments where
    // the test meant one. A separate outDir, so running the tests never
    // clobbers a real build.
    const built = spawnSync(
      process.execPath,
      [join(REPO, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', OUT_REL, '--emptyOutDir', '--logLevel', 'error'],
      { cwd: REPO, encoding: 'utf8' },
    );
    if (built.status !== 0) {
      throw new Error(`vite build failed (${built.status}):\n${built.stdout}\n${built.stderr}`);
    }
    const assets = join(OUT_DIR, 'assets');
    const css = readdirSync(assets).filter((f) => f.endsWith('.css'));
    if (css.length === 0) throw new Error(`the build emitted no CSS into ${assets}`);
    return css.map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');
  }

  test('a token a .ts reads is a token the bundle declares', () => {
    const wanted = new Map<string, string[]>();
    for (const [name, source] of TS_SOURCES) {
      for (const ref of new Set(noFallbackReferences(source))) {
        if (!ref.startsWith('--color-')) continue;
        wanted.set(ref, [...(wanted.get(ref) ?? []), name]);
      }
    }

    // A guard on the guard: if nothing references a token from TypeScript any
    // more, this test must say so rather than pass on an empty set.
    expect(wanted.size).toBeGreaterThan(0);

    const declared = definedProperties(builtCss());
    const missing = [...wanted]
      .filter(([token]) => !declared.has(token))
      .map(([token, files]) => `${token} (read by ${files.join(', ')})`);
    expect(missing).toEqual([]);
  }, 180_000);

  test('and the emitted CSS is a real stylesheet — the build actually ran', () => {
    // Without this, a build that emitted a near-empty stylesheet would satisfy
    // the assertion above vacuously (nothing declared, nothing to be missing
    // from) and still be reported as fine.
    expect(builtCss().length).toBeGreaterThan(10_000);
    // The scratch build is disposable; only the assertions are the artifact.
    if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  }, 180_000);
});

describe('rule 5: every theme defines the same token names', () => {
  // The swap is safe only if the names line up. A theme that drops a name
  // leaves every `var()` that reads it resolving to nothing, and the swap
  // still "works" — the page renders, just wrong.
  const rootNames = (theme: { css: string }) => [...tokensIn(themeBlocks(theme.css, ':root')).keys()].sort();

  test('there is more than one theme to compare', () => {
    expect(THEMES.length).toBeGreaterThan(1);
  });

  test('every theme declares exactly the same :root tokens as the first', () => {
    const [first, ...rest] = THEMES;
    const expected = rootNames(first!);
    const problems = rest.flatMap((t) => {
      const have = rootNames(t);
      return [
        ...expected.filter((n) => !have.includes(n)).map((n) => `${t.name} is missing ${n}`),
        ...have.filter((n) => !expected.includes(n)).map((n) => `${t.name} adds ${n}`),
      ];
    });
    expect(problems).toEqual([]);
  });

  test('no theme defines a dark token its light block does not declare', () => {
    const problems = THEMES.flatMap((t) => {
      const light = new Set(rootNames(t));
      return [...tokensIn(themeBlocks(t.css, ':root.dark')).keys()]
        .filter((n) => !light.has(n))
        .map((n) => `${t.name} defines ${n} only in dark`);
    });
    expect(problems).toEqual([]);
  });
});

describe('rule 6: corner radii are tokens, not literals', () => {
  test('styles.css writes no literal border-radius', () => {
    expect(stripComments(STYLES_CSS).match(/border-radius:\s*\d/g)).toBeNull();
  });

  test('the class strings and primitives write no literal rounded-[Npx]', () => {
    // `rounded-full` stays where a circle is the point (the spinner). What this
    // forbids is a pixel corner, which a theme could not reach.
    const literal = TS_SOURCES.filter(([name]) => name.startsWith('ui/')).flatMap(([name, source]) =>
      [...codeOnly(source).matchAll(/rounded-\[\d[^\]]*\]/g)].map((m) => `${name}: ${m[0]}`),
    );
    expect(literal).toEqual([]);
  });

  test('the Tailwind radius scale points at the theme, not at numbers', () => {
    const bridge = TOKENS_CODE.match(/@theme inline\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const radii = [...bridge.matchAll(/(--radius-[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)];
    expect(radii.length).toBeGreaterThan(2);
    expect(radii.filter(([, , value]) => !value!.trim().startsWith('var('))).toEqual([]);
  });
});

describe('the focus ring is drawn from the focus token', () => {
  // The rule the keyboard user sees. It reads --color-focus for the ring, and a
  // text-coloured keyline so the ring is visible on a light page: a yellow ring
  // alone is about 1.4:1 there, under the 3:1 a focus indicator needs.
  const focusRule = stripComments(STYLES_CSS).match(/(?:^|\n):focus-visible\s*\{([^}]*)\}/)?.[1] ?? '';

  test('the global ring reads the focus token', () => {
    expect(focusRule).toContain('var(--color-focus)');
  });

  test('the ring carries a text-coloured keyline', () => {
    expect(focusRule).toContain('var(--color-text)');
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
