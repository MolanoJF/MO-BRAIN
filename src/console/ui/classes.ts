/**
 * The design system's class strings, as pure functions.
 *
 * This is the tested half of `src/console/ui/`. It imports nothing — no React,
 * no DOM — so `test/unit/console-ui.test.ts` can assert every one of these
 * decisions without a browser, which is the same convention `phaseFor`
 * (`App.tsx`), `parseRoute` (`router.ts`) and `sourceNavigation`
 * (`AppShell.tsx`) already follow. `ui/index.tsx` is a thin wrapper over what
 * is here and holds no styling decisions of its own.
 *
 * The specs are qm's, from `qm/plugins/admin/public/admin-components.css`.
 * qm writes them as semantic CSS rules because qm has no Tailwind; this repo
 * does, so the same computed values are assembled as utilities here instead of
 * as a second stylesheet. Utilities that reference a token by name
 * (`bg-surface`, `border-border`) resolve through the `@theme inline` bridge in
 * `styles/tokens.css`, so every one of them re-paints under `:root.dark`.
 *
 * Two rules this module keeps, and why:
 *
 * 1. **Every class name is a whole literal.** Never `` `text-${tone}` ``.
 *    Tailwind finds the classes it must generate by scanning these files as
 *    plain text, so a spliced name produces no CSS at all — the class would
 *    appear in the DOM and style nothing, which is a silent failure rather
 *    than a loud one. `test/unit/console-ui.test.ts` asserts this.
 * 2. **No two utilities in one returned string set the same property.** The
 *    class attribute's order does not decide the winner; the order Tailwind
 *    emits them in does. So `buttonClass` keeps the colour properties out of
 *    the shared chrome and lets each variant supply exactly one background,
 *    one border colour and one text colour. That is also why this module does
 *    not want `tailwind-merge` — there is nothing to merge.
 *
 *    `tableClass` is the one deliberate exception, and it is deliberate
 *    precisely because rule 2 has no answer for per-column alignment. Its
 *    override utilities are descendant variants carrying a `:nth-child()`, so
 *    their compiled selectors are strictly MORE specific than the base
 *    `[&_th]:text-left`, and specificity — not emit order — decides. See
 *    `tableClass` for the whole argument.
 *
 * A third thing lives here too: the two-click confirm's state machine
 * (`confirmPress`, `confirmDisarmsOnBlur`). It is not a class string, but it is
 * an observable decision on a destructive control, and this is the only module
 * in `ui/` a unit test can import without a DOM.
 */

/**
 * A status colour. The first four are the exact union `pages/Runs.tsx`,
 * `pages/Schedules.tsx` and `pages/Health.tsx` each declare privately today
 * (three verbatim copies of the same `TONE_CLASS` map); Phase 4 deletes all
 * three in favour of this one. `neutral` is new, for a badge that carries no
 * status at all.
 */
export type Tone = 'ok' | 'warning' | 'danger' | 'muted' | 'neutral';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'link';

/**
 * How a button distributes its own children along the row.
 *
 * This is a prop rather than something a caller passes through `extra` because
 * of rule 2: the chrome used to hardcode `justify-center`, so `Schema.tsx`'s
 * pack disclosure row — a label on the left, an ACTIVE badge on the right —
 * could not ask for `justify-between` and rely on winning. It worked around it
 * with a `<span className="flex w-full justify-between">` wrapped inside the
 * button. Making the layout a named choice means exactly one
 * `justify-content` utility is ever emitted, so the collision cannot happen
 * rather than being worked around one call site at a time.
 */
export type ButtonLayout = 'center' | 'between' | 'start';

/**
 * The tone-to-colour mapping, which must stay injective: two tones that
 * collapse onto one class would render a failed run in the same colour as a
 * healthy one, and nothing would look wrong until an operator trusted it.
 */
export function toneClass(tone: Tone): string {
  switch (tone) {
    case 'ok': return 'text-ok';
    case 'warning': return 'text-warning';
    case 'danger': return 'text-danger';
    case 'muted': return 'text-muted';
    case 'neutral': return 'text-text';
  }
}

/**
 * qm's button chrome (`admin-components.css:28-57`): `min-height:
 * var(--control-height)`, `padding: 6px 12px`, `1px solid var(--border)`,
 * `border-radius: var(--control-radius)`, `13px/500`, `line-height: 18px`.
 *
 * `--spacing` is 4px, so `px-3 py-1.5` is exactly qm's `6px 12px`. Colours are
 * deliberately absent — see rule 2 in the module comment. `inline-flex` and the
 * `gap-2` (qm's `--control-gap`) are the one addition: qm's admin buttons are
 * label-only, and an icon beside a label needs a row box to sit in.
 */
const BUTTON_CHROME =
  'inline-flex items-center gap-2 ' +
  'min-h-[var(--control-height)] px-3 py-1.5 ' +
  'rounded-[var(--control-radius)] border shadow-none ' +
  'text-[length:var(--control-font)] font-medium leading-[18px] ' +
  'disabled:cursor-not-allowed';

/**
 * `enabled:hover:` rather than a bare `hover:` throughout, because qm scopes
 * every button hover with `:hover:not(:disabled)` — a disabled control that
 * still lights up on hover reads as clickable and is not.
 */
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  // qm's default button: the surface colour, not the page colour, so a button
  // on a card still reads as a control rather than as part of the card.
  secondary: 'bg-surface text-text border-border enabled:hover:bg-subtle disabled:opacity-45',

  // `button.primary` (`admin-components.css:66-78`). Its disabled state is the
  // one qm overrides away from the shared `opacity: 0.45`: a 45%-faded solid
  // CTA still looks like a live filled button, so qm drops it to the flat
  // subtle/muted pair and restores full opacity instead.
  primary:
    'bg-cta text-cta-foreground border-cta ' +
    'enabled:hover:bg-cta-hover enabled:hover:border-cta-hover ' +
    'disabled:bg-subtle disabled:border-border disabled:text-muted disabled:opacity-100',

  // `button.danger` is the standard chrome with red *text* — qm never fills a
  // destructive button, so the dangerous action is never the loudest thing on
  // the screen.
  danger: 'bg-surface text-danger border-border enabled:hover:bg-subtle disabled:opacity-45',

  // `.link` / `.viewlink`: `13px/400`, `line-height: 1.4`, and none of the
  // chrome above — so this variant does not compose with BUTTON_CHROME.
  link:
    'inline-flex items-center gap-2 bg-transparent border-0 p-0 shadow-none ' +
    'text-[length:var(--control-font)] font-normal leading-[1.4] text-cta ' +
    'enabled:hover:underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-45',
};

/**
 * The only place a `justify-content` utility is chosen, so there is never a
 * second one for it to fight with.
 */
const BUTTON_JUSTIFY: Record<ButtonLayout, string> = {
  center: 'justify-center',
  between: 'justify-between',
  start: 'justify-start',
};

export function buttonClass(variant: ButtonVariant, extra?: string, layout: ButtonLayout = 'center'): string {
  const base = variant === 'link' ? BUTTON_VARIANT.link : `${BUTTON_CHROME} ${BUTTON_VARIANT[variant]}`;
  const withLayout = `${base} ${BUTTON_JUSTIFY[layout]}`;
  return extra ? `${withLayout} ${extra}` : withLayout;
}

/**
 * A settings-nav row: full width, left-aligned, borderless, and quiet until it
 * is the current one.
 *
 * This is `.nav-item` from `styles.css`, ported class for class — it is the
 * last shape in the console that `buttonClass` genuinely cannot express.
 * `Button` centres its label and draws a border, and rule 2 means a caller
 * cannot reach in with `justify-start border-0` and rely on winning; a nav rail
 * is a different control, so it gets a different primitive rather than a prop
 * that quietly undoes half of `Button`.
 *
 * Deliberately NO font-size utility. `.nav-item` set none and inherited the
 * page's, and pinning it to `--control-font` here would shrink the settings
 * nav — a visible change, and this pass restyles rather than redesigns.
 *
 * The `focus-visible` offset is negative for the same reason `styles.css` gave
 * it one: these rows are full-bleed inside a scrolling, overflow-hidden rail,
 * where an outset ring is clipped away by the very box it marks.
 */
export function navItemClass(active = false): string {
  return (
    'block w-full px-2 py-1.5 text-left rounded-[4px] ' +
    'focus-visible:outline-offset-[-2px] ' +
    (active
      ? 'bg-surface text-cta'
      : 'bg-transparent text-text enabled:hover:bg-surface')
  );
}

/**
 * Where a link is sitting, which is the only thing that decides its colour.
 *
 * `buttonClass('link')` cannot do an anchor's job: its hover is
 * `enabled:hover:underline`, and `:enabled` matches only form controls, so on
 * an `<a>` the underline never appears and the affordance is gone.
 */
export type LinkSurface = 'page' | 'notice';

/**
 * `page` is the ordinary case: CTA-coloured, underlined on hover.
 *
 * `notice` exists because `text-cta` is NOT safe on every surface. Inside a
 * warning `Notice` the background is `--warn-surface`, which in dark mode is an
 * olive fill, and `--cta` there is a dark navy that all but disappears against
 * it. So a link on that surface inherits the notice's own copy colour
 * (`--warn-text`, which the notice already guarantees is legible) and carries a
 * permanent underline instead — the one affordance that survives both themes
 * without depending on a colour pairing nobody checked.
 */
const LINK_SURFACE: Record<LinkSurface, string> = {
  page: 'text-cta hover:underline',
  notice: 'text-current underline',
};

export function linkClass(surface: LinkSurface = 'page', extra?: string): string {
  const base = `underline-offset-2 ${LINK_SURFACE[surface]}`;
  return extra ? `${base} ${extra}` : base;
}

/**
 * qm's badge (`admin-components.css:213-224`): a pill whose fill and border are
 * both mixed out of its own `color`, so a tone only ever has to set one
 * property and the fill can never drift out of step with the text.
 *
 * Knowing deviation: `bg-current/7` and `border-current/14` mix in oklab, where
 * qm's `color-mix(in srgb, currentColor 7%, transparent)` mixes in sRGB. At 7%
 * and 14% alpha against the same currentColor the two are not distinguishable,
 * and this keeps the class names whole literals (rule 1) instead of an
 * underscore-escaped `color-mix()` arbitrary value.
 */
export function badgeClass(tone: Tone): string {
  return (
    'inline-flex items-center px-[9px] py-[3px] rounded-full border ' +
    'text-xs font-normal leading-[1.4] bg-current/7 border-current/14 ' +
    toneClass(tone)
  );
}

/**
 * qm's input/select/textarea (`admin-components.css:95-116`): `padding: 6px
 * 10px`, `13px/400`, the same border, radius and surface as a button, and
 * `:disabled` dropping to the subtle background with muted text.
 *
 * `invalid` swaps the border to `--danger` rather than adding a second border
 * colour, per rule 2. Callers pair it with `aria-invalid`, which is what
 * actually tells a screen reader; the colour alone never is.
 */
export function fieldClass(invalid = false): string {
  return (
    'w-full min-h-[var(--control-height)] px-2.5 py-1.5 ' +
    'rounded-[var(--control-radius)] border shadow-none bg-surface text-text ' +
    'text-[length:var(--control-font)] font-normal leading-[18px] ' +
    'disabled:bg-subtle disabled:text-muted disabled:cursor-not-allowed ' +
    (invalid ? 'border-danger' : 'border-border')
  );
}

/* ------------------------------------------------------------------ Notice */

/**
 * A notice is either an icon beside one line, or a block of stacked lines.
 *
 * `row` was the only shape Phase 1 shipped, and the migration paid for it: the
 * plan's Layer 2 table promised a `<Card tone="warning">` for the multi-line
 * warning blocks, no such thing existed, so every one of them became a `Notice`
 * — a `flex items-start` ROW — and then needed a `<div className="w-full">`
 * wrapper (about ten sites) or a `flex-col` passed through `className` (about
 * five) to get its children back onto separate lines. Both are the call site
 * paying for a missing variant, and `flex-col` passed that way is exactly the
 * rule-2 coin flip this module forbids: `flex-row` and `flex-col` both set
 * `flex-direction`. Naming the two shapes means only ever one of them is
 * emitted.
 *
 * `stack` is therefore the warning CARD the plan named, wearing the notice's
 * skin. There is no separate `Card tone="warning"`: two primitives painting one
 * surface is how the two drift apart.
 */
export type NoticeLayout = 'row' | 'stack';

const NOTICE_LAYOUT: Record<NoticeLayout, string> = {
  row: 'flex-row items-start gap-2.5',
  /**
   * `items-start`, not `items-stretch`. Stretch is the tempting one — it is
   * exactly what the deleted `w-full` wrappers did — but a flex item is
   * blockified, so a stretched `<a>` becomes a full-width block and the dead
   * space beside its text turns into a live click target. `items-start` gives
   * each child `fit-content`, which for a paragraph is still the full width
   * (prose wraps at the container either way) and for a link is the link.
   */
  stack: 'flex-col items-start gap-2',
};

export function noticeClass(tone: Tone = 'warning', layout: NoticeLayout = 'row'): string {
  const shape =
    'flex rounded-[var(--radius)] border px-4 py-3.5 ' +
    'text-[length:var(--control-font)] font-normal leading-[1.5]';
  // `warning` uses qm's dedicated --warn-surface / --warn-border / --warn-text
  // triple — a real third colour per theme, not a tint of the text colour —
  // because a warning has to stay legible against both a white and a near-black
  // page. Every other tone tints from its own colour, the same mechanic as
  // `badgeClass`.
  const skin =
    tone === 'warning'
      ? 'bg-warn-surface border-warn-border text-warn-text'
      : `bg-current/7 border-current/14 ${toneClass(tone)}`;
  return `${shape} ${NOTICE_LAYOUT[layout]} ${skin}`;
}

/* ------------------------------------------------------------------- Table */

export type ColumnAlign = 'left' | 'right' | 'center';

/**
 * qm styles bare `th`/`td` globally; this repo cannot, so the same declarations
 * ride as descendant variants on the table itself.
 */
const TABLE_CHROME =
  'w-full border-collapse text-[length:var(--control-font)] ' +
  '[&_th]:px-3 [&_th]:py-2.5 [&_th]:text-left [&_th]:text-xs [&_th]:font-normal ' +
  '[&_th]:leading-[1.4] [&_th]:text-muted [&_th]:border-b [&_th]:border-border ' +
  '[&_td]:p-3 [&_td]:leading-[1.4] [&_td]:border-b [&_td]:border-border';

/**
 * The per-column alignment escape hatch, one whole literal per column.
 *
 * Why it has to exist: `[&_th]:text-left` compiles to `.\[\&_th\]\:text-left th`,
 * specificity (0,1,1), which outranks a plain `.text-right` (0,1,0) written on
 * the `th` itself. So a money column styled per cell silently drifted back to
 * the left, and `Spend.tsx` and `Schema.tsx` each grew their own descendant
 * variant to out-specify it. That is two call sites reasoning about
 * specificity, and a third would have got it wrong.
 *
 * Why it looks like this: rule 1 forbids `` `[&_th:nth-child(${i})]:text-right` ``
 * — Tailwind finds classes by scanning this file as plain text, so a spliced
 * name produces no CSS at all. The literals are therefore written out.
 *
 * Why it is safe: each carries a `:nth-child()`, so the compiled selector is
 * (0,2,1) and beats the base's (0,1,1) on specificity rather than on emit
 * order. This is the one place in the module where two utilities set the same
 * property on purpose, and it is decided by the cascade, not by luck.
 */
const COLUMN_RIGHT: readonly string[] = [
  '[&_th:nth-child(1)]:text-right [&_td:nth-child(1)]:text-right',
  '[&_th:nth-child(2)]:text-right [&_td:nth-child(2)]:text-right',
  '[&_th:nth-child(3)]:text-right [&_td:nth-child(3)]:text-right',
  '[&_th:nth-child(4)]:text-right [&_td:nth-child(4)]:text-right',
  '[&_th:nth-child(5)]:text-right [&_td:nth-child(5)]:text-right',
  '[&_th:nth-child(6)]:text-right [&_td:nth-child(6)]:text-right',
  '[&_th:nth-child(7)]:text-right [&_td:nth-child(7)]:text-right',
  '[&_th:nth-child(8)]:text-right [&_td:nth-child(8)]:text-right',
];

const COLUMN_CENTER: readonly string[] = [
  '[&_th:nth-child(1)]:text-center [&_td:nth-child(1)]:text-center',
  '[&_th:nth-child(2)]:text-center [&_td:nth-child(2)]:text-center',
  '[&_th:nth-child(3)]:text-center [&_td:nth-child(3)]:text-center',
  '[&_th:nth-child(4)]:text-center [&_td:nth-child(4)]:text-center',
  '[&_th:nth-child(5)]:text-center [&_td:nth-child(5)]:text-center',
  '[&_th:nth-child(6)]:text-center [&_td:nth-child(6)]:text-center',
  '[&_th:nth-child(7)]:text-center [&_td:nth-child(7)]:text-center',
  '[&_th:nth-child(8)]:text-center [&_td:nth-child(8)]:text-center',
];

/** How many columns the literal table above covers. The widest table in the
 *  console has five. */
export const TABLE_MAX_COLUMNS = COLUMN_RIGHT.length;

/**
 * `align` is read positionally: entry *i* aligns column *i + 1*. `left` is the
 * default and emits nothing, so a shorter array simply leaves the rest alone.
 *
 * A column past `TABLE_MAX_COLUMNS` throws rather than being ignored. Ignoring
 * it is the failure this whole function exists to remove — a column that reads
 * left while the author asked for right, with nothing anywhere saying so.
 */
export function tableClass(align?: readonly ColumnAlign[]): string {
  if (align === undefined || align.length === 0) return TABLE_CHROME;
  if (align.length > TABLE_MAX_COLUMNS) {
    throw new RangeError(
      `tableClass: ${align.length} columns, but only ${TABLE_MAX_COLUMNS} are spelled out. ` +
      'Add the next literal to COLUMN_RIGHT/COLUMN_CENTER in ui/classes.ts.',
    );
  }
  const overrides = align
    .map((a, i) => (a === 'right' ? COLUMN_RIGHT[i]! : a === 'center' ? COLUMN_CENTER[i]! : ''))
    .filter((s) => s.length > 0);
  return overrides.length === 0 ? TABLE_CHROME : `${TABLE_CHROME} ${overrides.join(' ')}`;
}

/* ----------------------------------------------------- The two-click confirm */

/** What the next press of a `ConfirmButton` does. */
export type ConfirmPress = 'arm' | 'confirm';

/**
 * The whole two-click gate, in one line, so a test can assert that the FIRST
 * press never deletes anything. Not a class string, but it is the observable
 * behaviour of a destructive control and `ui/index.tsx` is unreachable from a
 * test in a repo with no DOM harness.
 */
export function confirmPress(armed: boolean): ConfirmPress {
  return armed ? 'confirm' : 'arm';
}

/**
 * Should an armed confirm disarm when it loses focus?
 *
 * Only when nothing else owns the armed state. Blur-to-disarm exists so an
 * armed destructive button is never left sitting in the page for whoever clicks
 * there next — but when the caller controls `armed` it also renders the
 * explicit way out beside it ("Keep it"), and moving toward that button blurs
 * this one. Disarming on that blur would pull the escape hatch out from under
 * the pointer, which is worse than the trap it was guarding against.
 */
export function confirmDisarmsOnBlur(controlled: boolean): boolean {
  return !controlled;
}
