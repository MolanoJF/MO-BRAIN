import type { LucideIcon } from 'lucide-react';

/**
 * Every icon in the console renders through here, mirroring qm's `icon()`
 * helper (`qm/plugins/web-ui/src/ui.ts:199-209`). The point of a single
 * wrapper is that the three attributes below are decided once instead of at
 * each of the call sites that will exist after Phases 2-4:
 *
 *  - **`strokeWidth={1.9}`.** lucide's default is 2, which reads heavy beside
 *    13px control text. 1.9 is qm's value, and matching it is most of why
 *    qm's icons look like they belong to the same family as its type.
 *  - **`aria-hidden` + `focusable="false"`.** Every icon here sits next to a
 *    label or inside a button that already carries an `aria-label`, so an
 *    announced icon is a duplicate reading, and in IE-era focus terms a
 *    focusable SVG is a phantom tab stop. A genuinely standalone icon needs
 *    its meaning on the surrounding control, never on the glyph.
 *  - **Size as an explicit prop on `width`/`height`.** Not a CSS rule: an icon
 *    sized by the cascade can disagree with the box it sits in and reflow it
 *    a frame later. Pinned attributes cannot.
 */
export function Icon({
  glyph: Glyph, size = 18, className,
}: {
  glyph: LucideIcon;
  size?: number;
  className?: string;
}) {
  return (
    <Glyph
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      strokeWidth={1.9}
      aria-hidden="true"
      focusable="false"
    />
  );
}
