import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  badgeClass, buttonClass, confirmDisarmsOnBlur, confirmPress, eyebrowClass, fieldClass, linkClass,
  metricClass, navItemClass, noticeClass, pageTitleClass, progressFillClass, progressTrackClass,
  sectionTitleClass, tableClass, toneClass, TABLE_MAX_COLUMNS,
  type ButtonLayout, type ButtonVariant, type ColumnAlign, type LinkSurface,
  type NoticeLayout, type Tone,
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
const LAYOUTS: readonly ButtonLayout[] = ['center', 'between', 'start'];
const SURFACES: readonly LinkSurface[] = ['page', 'notice'];
const NOTICE_LAYOUTS: readonly NoticeLayout[] = ['row', 'stack'];

/** The class names in a string that are not scoped to a state. Variants
 *  (`hover:`, `focus:`, `enabled:`) never conflict with the bare utility. */
const bare = (cls: string): string[] => cls.split(/\s+/).filter((t) => t.length > 0 && !t.includes(':'));

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

  test('secondary lifts on hover: the border goes to ink and the button grows by --hover-scale', () => {
    // The brand's hover. Both halves are enabled-scoped, so a disabled button
    // does not lift and read as clickable.
    expect(buttonClass('secondary')).toContain('enabled:hover:border-text');
    expect(buttonClass('secondary')).toContain('enabled:hover:scale-[var(--hover-scale)]');
    expect(buttonClass('primary')).not.toContain('scale-');
  });

  test('every filled or outlined variant moves on the brand easing and duration', () => {
    // One easing and one duration for every control, so a row of buttons
    // settles together. Both are tokens: qm sets the duration to zero.
    for (const v of VARIANTS.filter((x) => x !== 'link')) {
      expect(buttonClass(v)).toContain('ease-[var(--ease)]');
      expect(buttonClass(v)).toContain('duration-[var(--duration)]');
    }
  });

  test('the transition names its properties, so a focus ring never fades in', () => {
    // The bare `transition` utility animates outline-color and box-shadow too. A
    // focus ring that faded in from the text colour would read as a black ring
    // for the first 280ms, and the ring is meant to be yellow at once.
    for (const v of VARIANTS.filter((x) => x !== 'link')) {
      expect(bare(buttonClass(v))).not.toContain('transition');
      expect(buttonClass(v)).toContain('transition-[color,background-color,border-color,scale]');
    }
  });

  test('extra classes are appended, not substituted', () => {
    const cls = buttonClass('primary', 'w-full');
    expect(cls).toContain('w-full');
    expect(cls).toContain('bg-cta');
  });
});

describe('buttonClass layout: one justify-content, decided by a name', () => {
  /** Every utility that sets `justify-content`, whatever the layout. */
  const justifies = (cls: string): string[] => cls.split(/\s+/).filter((t) => t.startsWith('justify-'));

  test('a button emits exactly one justify-content, in every variant and layout', () => {
    // The collision this closes: the chrome hardcoded `justify-center`, so
    // `Schema.tsx`'s disclosure row could not pass `justify-between` and rely
    // on winning — the emitted CSS order decides, not the class attribute — and
    // it worked around it with a flex `<span>` wrapped inside the button.
    for (const v of VARIANTS) {
      for (const l of LAYOUTS) {
        expect(justifies(buttonClass(v, undefined, l))).toEqual([`justify-${l}`]);
      }
    }
  });

  test('center is the default, so no existing call site moved', () => {
    for (const v of VARIANTS) expect(justifies(buttonClass(v))).toEqual(['justify-center']);
  });

  test('extra classes still land after the layout', () => {
    const cls = buttonClass('secondary', 'w-full', 'between');
    expect(cls).toContain('justify-between');
    expect(cls).toContain('w-full');
    expect(cls).not.toContain('justify-center');
  });
});

describe('navItemClass: the shape buttonClass genuinely cannot take', () => {
  test('a nav row is full-width and left-aligned, where a button is neither', () => {
    // If these ever coincide, `NavItem` has stopped earning its existence and
    // the settings rail should go back to being a `Button`.
    for (const active of [true, false]) {
      const cls = navItemClass(active);
      expect(cls).toContain('w-full');
      expect(cls).toContain('text-left');
      expect(cls).not.toContain('justify-center');
      // No box around the row: a bordered rail row reads as a stack of buttons
      // rather than as a list. The one border is the 2px bar on the left edge,
      // and nothing else may be drawn.
      const borders = bare(cls).filter((t) => t.startsWith('border'));
      expect(borders).toContain('border-l-2');
      expect(borders.filter((t) => !['border-l-2', 'border-accent', 'border-transparent'].includes(t))).toEqual([]);
    }
  });

  test('active is the selected surface with the accent bar, and inactive is neither', () => {
    expect(navItemClass(true)).toContain('bg-selected-surface');
    expect(navItemClass(true)).toContain('border-accent');
    expect(navItemClass(true)).toContain('text-text');
    expect(navItemClass(false)).not.toContain('bg-selected-surface');
    expect(navItemClass(false)).not.toContain('border-accent');
  });

  test('the bar is the same width in both states, so the label does not move', () => {
    // A bar that appeared only on the current row would push its label two
    // pixels right every time the selection changed.
    expect(bare(navItemClass(true))).toContain('border-l-2');
    expect(bare(navItemClass(false))).toContain('border-l-2');
    expect(bare(navItemClass(false))).toContain('border-transparent');
  });

  test('the corner is the control radius, not a pixel literal', () => {
    expect(navItemClass(false)).toContain('rounded-[var(--control-radius)]');
  });

  test('active and inactive each set exactly one background and one text colour', () => {
    // Same rule-2 reason as `buttonClass`: two backgrounds in one string is a
    // coin flip decided by Tailwind's emit order.
    for (const active of [true, false]) {
      const bare = navItemClass(active).split(/\s+/).filter((t) => t.length > 0 && !t.includes(':'));
      expect(bare.filter((t) => t.startsWith('bg-')).length).toBe(1);
      expect(bare.filter((t) => /^text-(?!left|right|center)/.test(t)).length).toBe(1);
    }
  });

  test('it carries its own inset focus ring, because styles.css no longer does', () => {
    // `.nav-item:focus-visible { outline-offset: -2px }` was deleted with the
    // class. These rows are full-bleed inside a scrolling, overflow-hidden
    // rail, where an outset ring is clipped away by the box it marks — so
    // losing this makes the settings rail invisible to a keyboard user.
    expect(navItemClass(false)).toContain('focus-visible:outline-offset-[-2px]');
  });

  test('hover is scoped to enabled rows', () => {
    for (const token of navItemClass(false).split(/\s+/).filter((t) => t.includes('hover:'))) {
      expect(token.startsWith('enabled:hover:')).toBe(true);
    }
  });
});

describe('linkClass: an anchor is not a button, and text-cta is not safe everywhere', () => {
  test('no surface uses the `enabled:` variant', () => {
    // This is the whole bug `Link` exists to fix. `buttonClass('link')` hovers
    // with `enabled:hover:underline`, and `:enabled` matches only form
    // controls — on an `<a>` the underline never appears and the only
    // affordance the link had is gone, silently.
    for (const s of SURFACES) expect(linkClass(s)).not.toContain('enabled:');
  });

  test('a page link is CTA-coloured and underlined all the time', () => {
    // In MOLIOR the CTA is the text colour, so on a page a link is recognisable
    // only by its underline. That underline cannot wait for a hover.
    expect(linkClass('page')).toContain('text-cta');
    expect(bare(linkClass('page'))).toContain('underline');
  });

  test('a link on a notice never paints itself text-cta', () => {
    // --cta is a dark navy; the dark theme's --warn-surface is an olive fill,
    // and the two are all but the same value. A link nobody can see on a
    // warning is worse than no link: the warning still implies there is one.
    expect(linkClass('notice')).not.toContain('text-cta');
    expect(linkClass('notice')).toContain('text-current');
  });

  test('a notice link is underlined unconditionally, not only on hover', () => {
    // Colour cannot be the affordance on that surface, so the underline has to
    // be there before the pointer is.
    const bare = linkClass('notice').split(/\s+/).filter((t) => !t.includes(':'));
    expect(bare).toContain('underline');
  });

  test('every surface sets exactly one text colour', () => {
    for (const s of SURFACES) {
      const bare = linkClass(s).split(/\s+/).filter((t) => t.length > 0 && !t.includes(':'));
      expect(bare.filter((t) => /^text-/.test(t)).length).toBe(1);
    }
  });

  test('extra classes are appended, not substituted', () => {
    expect(linkClass('page', 'font-mono')).toContain('font-mono');
    expect(linkClass('page', 'font-mono')).toContain('text-cta');
  });
});

describe('noticeClass: two layouts, and only ever one flex-direction', () => {
  test('a notice emits exactly one flex-direction', () => {
    // The failure this closes: `layout` did not exist, so five call sites
    // passed `className="flex-col"` alongside the built-in `items-start` row —
    // `flex-row` and `flex-col` both set `flex-direction`, so which one won was
    // Tailwind's emit order, not the call site's.
    for (const t of TONES) {
      for (const l of NOTICE_LAYOUTS) {
        const dirs = noticeClass(t, l).split(/\s+/).filter((c) => c === 'flex-row' || c === 'flex-col');
        expect(dirs).toEqual([l === 'row' ? 'flex-row' : 'flex-col']);
      }
    }
  });

  test('a stacked notice needs no w-full from its children', () => {
    // The wrapper this variant deletes: about ten sites wrapped their contents
    // in `<div className="w-full">` purely to escape the row shape.
    expect(noticeClass('warning', 'stack')).toContain('flex-col');
    expect(noticeClass('warning', 'row')).toContain('items-start');
  });

  test('warning is the only tone that uses the dedicated warn triple', () => {
    // Every other tone tints from its own colour. Warning cannot: it has to
    // stay legible against both a white and a near-black page, which a tint of
    // the text colour does not.
    const warnOnly = TONES.filter((t) => noticeClass(t).includes('bg-warn-surface'));
    expect(warnOnly).toEqual(['warning']);
    expect(noticeClass('warning')).toContain('border-warn-border');
    expect(noticeClass('warning')).toContain('text-warn-text');
  });

  test('every non-warning tone still carries its own tone colour', () => {
    for (const t of TONES.filter((x) => x !== 'warning')) {
      expect(noticeClass(t)).toContain(toneClass(t));
      expect(noticeClass(t)).toContain('bg-current/7');
    }
  });

  test('the defaults are the shape Phase 1 shipped, so no existing site moved', () => {
    expect(noticeClass()).toBe(noticeClass('warning', 'row'));
  });
});

describe('tableClass: a numeric column can actually be right-aligned', () => {
  test('with no alignment it is exactly the chrome every table had', () => {
    expect(tableClass()).toBe(tableClass([]));
    expect(tableClass()).toContain('[&_th]:text-left');
  });

  test('a right-aligned column out-specifies the header rule rather than racing it', () => {
    // `.[&_th]:text-left th` is specificity (0,1,1) and beats a plain
    // `.text-right` (0,1,0) written on the `th`. That is why `Spend`'s money
    // column silently drifted left. Every override here carries an
    // `:nth-child()`, so its compiled selector is (0,2,1) and the cascade — not
    // the emit order — decides.
    const cls = tableClass(['left', 'right', 'right']);
    expect(cls).toContain('[&_th:nth-child(2)]:text-right');
    expect(cls).toContain('[&_td:nth-child(2)]:text-right');
    expect(cls).toContain('[&_th:nth-child(3)]:text-right');
    expect(cls).not.toContain('[&_th:nth-child(1)]:text-right');
  });

  test('left costs nothing, so a table of labels is byte-identical to the default', () => {
    expect(tableClass(['left', 'left', 'left'])).toBe(tableClass());
  });

  test('centre is available and never collides with right on the same column', () => {
    const cls = tableClass(['center', 'right']);
    expect(cls).toContain('[&_th:nth-child(1)]:text-center');
    expect(cls).not.toContain('[&_th:nth-child(1)]:text-right');
    expect(cls).toContain('[&_th:nth-child(2)]:text-right');
    expect(cls).not.toContain('[&_th:nth-child(2)]:text-center');
  });

  test('alignment is positional, and column N gets column N\'s literal', () => {
    for (let i = 0; i < TABLE_MAX_COLUMNS; i++) {
      const align: ColumnAlign[] = Array(i + 1).fill('left');
      align[i] = 'right';
      expect(tableClass(align)).toContain(`[&_th:nth-child(${i + 1})]:text-right`);
    }
  });

  test('a column past the last literal throws instead of quietly misaligning', () => {
    // Silently ignoring it is the exact failure this function removes: a column
    // that reads left while the author asked for right, and nothing anywhere
    // saying so.
    const tooMany: ColumnAlign[] = Array(TABLE_MAX_COLUMNS + 1).fill('right');
    expect(() => tableClass(tooMany)).toThrow(RangeError);
  });

  test('no class name is spliced, so Tailwind can still find every one', () => {
    for (let i = 0; i < TABLE_MAX_COLUMNS; i++) {
      const align: ColumnAlign[] = Array(i + 1).fill('right');
      expect(tableClass(align)).not.toContain('${');
    }
  });
});

describe('the two-click confirm: the first press never deletes anything', () => {
  test('an unarmed press arms, and an armed press confirms', () => {
    expect(confirmPress(false)).toBe('arm');
    expect(confirmPress(true)).toBe('confirm');
  });

  test('blur disarms only while nothing else owns the armed state', () => {
    // Uncontrolled, blur-to-disarm is the safety net: an armed destructive
    // button left sitting in the page is a trap for whoever clicks there next.
    expect(confirmDisarmsOnBlur(false)).toBe(true);
    // Controlled, it is the opposite. The caller renders the visible way out
    // ("Keep it") beside the button, and reaching for that button blurs this
    // one — disarming there would pull the escape hatch out from under the
    // pointer. `Schedules.tsx` is that caller.
    expect(confirmDisarmsOnBlur(true)).toBe(false);
  });
});

describe('badgeClass: the fill is mixed out of the tone, so the two cannot disagree', () => {
  test('every tone takes its corner from the pill token and derives its fill from currentColor', () => {
    // The corner is a token so the same badge is a pill in qm and a 2px square
    // in MOLIOR. A literal `rounded-full` would stay a pill under both.
    for (const t of TONES) {
      const cls = badgeClass(t);
      expect(cls).toContain('rounded-[var(--radius-pill)]');
      expect(cls).not.toContain('rounded-full');
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

  test('focus turns a valid field\'s border ink, and never adds a ring', () => {
    // The brand's field spec: the border carries the focus signal. styles.css
    // switches the global ring off for fields, so this is the only indication.
    expect(fieldClass()).toContain('focus:border-text');
    expect(fieldClass()).not.toContain('focus:outline');
  });

  test('an invalid field keeps its danger border when it is focused', () => {
    // Otherwise the error turns into a black border the moment someone clicks in
    // to fix it, and the field looks valid while it is still wrong.
    expect(fieldClass(true)).not.toContain('focus:border-text');
    expect(fieldClass(true)).toContain('border-danger');
  });

  test('a field is the page colour, so it reads as an inset against a card', () => {
    expect(fieldClass()).toContain('bg-bg');
    expect(fieldClass()).not.toContain('bg-surface');
  });
});

describe('headings, labels and figures: each reads a token and carries no colour of its own', () => {
  /** A text colour utility: `text-` that is neither a size nor a length. */
  const colourUtilities = (cls: string): string[] =>
    bare(cls).filter((t) => t.startsWith('text-') && !t.startsWith('text-[length') && t !== 'text-lg' && t !== 'text-xs');

  test('the page title takes its face from the heading tokens', () => {
    expect(pageTitleClass()).toContain('text-[length:var(--heading-size)]');
    expect(pageTitleClass()).toContain('[font-weight:var(--heading-weight)]');
    expect(colourUtilities(pageTitleClass())).toEqual([]);
  });

  test('a section title is the heading weight, and inherits its colour', () => {
    // It sits inside a danger notice on the Runs page. A colour of its own
    // would paint its title differently from the paragraph under it.
    expect(sectionTitleClass()).toContain('[font-weight:var(--heading-weight)]');
    expect(colourUtilities(sectionTitleClass())).toEqual([]);
  });

  test('a metric is the metric size, in tabular figures, and inherits its colour', () => {
    expect(metricClass()).toContain('text-[length:var(--metric-size)]');
    expect(metricClass()).toContain('tabular-nums');
    expect(colourUtilities(metricClass())).toEqual([]);
  });

  test('the eyebrow is the three label declarations, muted', () => {
    expect(eyebrowClass()).toContain('[font-family:var(--label-font)]');
    expect(eyebrowClass()).toContain('[text-transform:var(--label-transform)]');
    expect(eyebrowClass()).toContain('[letter-spacing:var(--label-tracking)]');
    expect(eyebrowClass()).toContain('text-muted');
  });

  test('a table header is the eyebrow style, so a column label and a label match', () => {
    // The header rule is a descendant variant, so it is checked as text: every
    // declaration the eyebrow carries must be present on `th` in the table.
    const table = tableClass();
    expect(table).toContain('[&_th]:[font-family:var(--label-font)]');
    expect(table).toContain('[&_th]:[text-transform:var(--label-transform)]');
    expect(table).toContain('[&_th]:[letter-spacing:var(--label-tracking)]');
  });

  test('a progress track is a 2px hairline, and its fill is the accent', () => {
    expect(progressTrackClass()).toContain('h-[2px]');
    expect(progressTrackClass()).toContain('bg-border');
    expect(progressFillClass()).toContain('bg-accent');
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
