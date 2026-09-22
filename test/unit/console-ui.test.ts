import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  badgeClass, buttonClass, fieldClass, toneClass,
  type ButtonVariant, type Tone,
} from '../../src/console/ui/classes.ts';
import { resolveTheme, type ThemeChoice } from '../../src/console/theme.ts';

/**
 * The design system's pure decisions. `ui/index.tsx` is a set of thin wrappers
 * over exactly these functions and holds no styling decision of its own, which
 * is deliberate: this repo has no DOM harness (no jsdom, no testing-library),
 * so a decision made inside a component is a decision no test can reach.
 *
 * These are trust properties, not shape echoes. Each one names the thing that
 * goes wrong when it fails.
 */

const TONES: readonly Tone[] = ['ok', 'warning', 'danger', 'muted', 'neutral'];
const VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary', 'danger', 'link'];

describe('toneClass: the mapping that replaces three copies of TONE_CLASS', () => {
  test('every tone gets a class, and no two tones share one', () => {
    // `pages/Runs.tsx`, `pages/Schedules.tsx` and `pages/Health.tsx` each
    // declare this map privately today. Phase 4 deletes all three in favour of
    // this one, so a collision here would paint a failed run the same colour
    // as a healthy one on three pages at once — and nothing would look broken.
    const classes = TONES.map(toneClass);
    expect(new Set(classes).size).toBe(TONES.length);
    for (const c of classes) expect(c.length).toBeGreaterThan(0);
  });

  test('the four existing tones keep the exact classes the pages already use', () => {
    // Not cosmetic: Phase 4 swaps the private maps for this function without
    // touching the call sites, so these four strings must not move.
    expect(toneClass('ok')).toBe('text-ok');
    expect(toneClass('warning')).toBe('text-warning');
    expect(toneClass('danger')).toBe('text-danger');
    expect(toneClass('muted')).toBe('text-muted');
  });
});

describe('buttonClass: one control height, one filled variant', () => {
  test('primary is the only variant that fills with the CTA colour', () => {
    // A second filled variant means two things on a screen both claiming to be
    // the main action, which is how a destructive button gets clicked.
    const filled = VARIANTS.filter((v) => buttonClass(v).includes('bg-cta'));
    expect(filled).toEqual(['primary']);
  });

  test('destructive is red text on the standard chrome, never a red fill', () => {
    expect(buttonClass('danger')).toContain('text-danger');
    expect(buttonClass('danger')).toContain('bg-surface');
    expect(buttonClass('danger')).not.toContain('bg-danger');
  });

  test('every chromed variant sits on the same control height and radius', () => {
    // qm's controls line up because they all read the same two tokens. A
    // variant that hardcodes its own height is a row of buttons 2px out of step.
    for (const v of VARIANTS.filter((x) => x !== 'link')) {
      expect(buttonClass(v)).toContain('min-h-[var(--control-height)]');
      expect(buttonClass(v)).toContain('rounded-[var(--control-radius)]');
    }
  });

  test('link carries none of the button chrome', () => {
    // A link that renders as a 32px bordered box is a button wearing a link's
    // job, and the two are not interchangeable to anyone reading the page.
    expect(buttonClass('link')).not.toContain('min-h-[var(--control-height)]');
    expect(buttonClass('link')).toContain('border-0');
  });

  test('hover is scoped to enabled controls on every variant', () => {
    // qm scopes every button hover with `:hover:not(:disabled)`. A disabled
    // control that still lights up on hover reads as clickable and is not.
    for (const v of VARIANTS) {
      const cls = buttonClass(v);
      for (const token of cls.split(/\s+/).filter((t) => t.includes('hover:'))) {
        expect(token.startsWith('enabled:hover:')).toBe(true);
      }
    }
  });

  test('primary disables to the flat subtle pair, not to a faded fill', () => {
    // qm overrides the shared `opacity: 0.45` for primary alone: a 45%-faded
    // solid CTA still reads as a live filled button.
    expect(buttonClass('primary')).toContain('disabled:opacity-100');
    expect(buttonClass('primary')).toContain('disabled:bg-subtle');
    expect(buttonClass('secondary')).toContain('disabled:opacity-45');
  });

  test('extra classes are appended, not substituted', () => {
    const cls = buttonClass('primary', 'w-full');
    expect(cls).toContain('w-full');
    expect(cls).toContain('bg-cta');
  });
});

describe('badgeClass: the fill is mixed out of the tone, so the two cannot disagree', () => {
  test('every tone keeps the pill shape and derives its fill from currentColor', () => {
    for (const t of TONES) {
      const cls = badgeClass(t);
      expect(cls).toContain('rounded-full');
      expect(cls).toContain('bg-current/7');
      expect(cls).toContain('border-current/14');
      expect(cls).toContain(toneClass(t));
    }
  });

  test('the tone is the only thing that varies between badges', () => {
    const withoutTone = TONES.map((t) => badgeClass(t).replace(toneClass(t), '').trim());
    expect(new Set(withoutTone).size).toBe(1);
  });
});

describe('fieldClass: invalid moves the border, and only the border', () => {
  test('a valid field borders with the hairline token', () => {
    expect(fieldClass()).toContain('border-border');
    expect(fieldClass()).not.toContain('border-danger');
  });

  test('an invalid field borders with danger, and never carries both', () => {
    // Two border-colour utilities in one string is a coin flip decided by
    // Tailwind's emission order, not by the order written here.
    expect(fieldClass(true)).toContain('border-danger');
    expect(fieldClass(true)).not.toContain('border-border');
  });

  test('a field shares the button control height, so a control row lines up', () => {
    expect(fieldClass()).toContain('min-h-[var(--control-height)]');
    expect(buttonClass('secondary')).toContain('min-h-[var(--control-height)]');
  });
});

describe('no returned class may set the same property twice', () => {
  /** The utility prefixes where a duplicate is a real conflict rather than a
   *  different property that happens to share a word (`text-xs` vs `text-ok`). */
  const CONFLICTING = ['bg-', 'border-', 'text-', 'rounded-', 'min-h-'];

  function bareUtilities(cls: string): string[] {
    // Variants (`disabled:`, `enabled:hover:`) scope a declaration to a state,
    // so they never conflict with the unscoped one.
    return cls.split(/\s+/).filter((t) => t.length > 0 && !t.includes(':'));
  }

  test('no button variant emits two utilities for the same property', () => {
    for (const v of VARIANTS) {
      for (const prefix of CONFLICTING) {
        const hits = bareUtilities(buttonClass(v)).filter((t) => t.startsWith(prefix));
        // `text-` legitimately carries both a size and a colour, so it is the
        // one prefix allowed a pair; everything else must be unique.
        expect(hits.length).toBeLessThanOrEqual(prefix === 'text-' ? 2 : 1);
      }
    }
  });

  test('no field state emits two border colours', () => {
    for (const invalid of [true, false]) {
      const hits = bareUtilities(fieldClass(invalid)).filter((t) => /^border-[a-z]/.test(t));
      expect(hits.length).toBe(1);
    }
  });
});

describe('every generated class name is a whole literal', () => {
  test('classes.ts never splices a class name from a variable', () => {
    // Tailwind finds the classes it must generate by scanning this file as
    // plain text. A name assembled at runtime — `text-${tone}` — produces no
    // CSS at all: the class lands in the DOM and styles nothing, which fails
    // silently rather than loudly. This is the only way to catch it without a
    // browser, so it is asserted against the source.
    // Read the DECLARATIONS, not the comments: the module comment quotes the
    // forbidden pattern verbatim, which is exactly what makes it a useful
    // comment and would otherwise make this test fail on its own warning.
    const source = readFileSync(join(import.meta.dir, '../../src/console/ui/classes.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const spliced = [...source.matchAll(/['"`][A-Za-z-]*-\$\{/g)].map((m) => m[0]);
    expect(spliced).toEqual([]);
  });

  test('and no returned string contains an unresolved template hole', () => {
    const all = [
      ...VARIANTS.map((v) => buttonClass(v)),
      ...TONES.map((t) => badgeClass(t)),
      fieldClass(), fieldClass(true),
      ...TONES.map(toneClass),
    ];
    for (const cls of all) expect(cls).not.toContain('${');
  });
});

describe('resolveTheme: an explicit choice beats the operating system', () => {
  test('system follows the OS, in both directions', () => {
    expect(resolveTheme('system', true)).toBe(true);
    expect(resolveTheme('system', false)).toBe(false);
  });

  test('light stays light even when the OS is dark', () => {
    // The bug this prevents: treating `system` as a fallback rather than as a
    // third answer, so somebody who deliberately picked Light gets dark anyway
    // after sunset and cannot work out why.
    expect(resolveTheme('light', true)).toBe(false);
  });

  test('dark stays dark even when the OS is light', () => {
    expect(resolveTheme('dark', false)).toBe(true);
  });

  test('the choice is total — every value of the union answers', () => {
    const choices: ThemeChoice[] = ['light', 'dark', 'system'];
    for (const c of choices) {
      for (const prefers of [true, false]) {
        expect(typeof resolveTheme(c, prefers)).toBe('boolean');
      }
    }
  });
});
