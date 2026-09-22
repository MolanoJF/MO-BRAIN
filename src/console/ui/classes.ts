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
  'inline-flex items-center justify-center gap-2 ' +
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

export function buttonClass(variant: ButtonVariant, extra?: string): string {
  const base = variant === 'link' ? BUTTON_VARIANT.link : `${BUTTON_CHROME} ${BUTTON_VARIANT[variant]}`;
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
