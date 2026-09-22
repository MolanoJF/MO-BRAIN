import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * The settings modal's shell: a backdrop and a card, portalled to `<body>`.
 * Ported from upstream baalda's `app/apps/desktop/src/components/SettingsModal.tsx`
 * — each mechanic below exists because a simpler version of it broke something
 * in production, and the reason is kept here rather than left to be
 * rediscovered.
 *
 * `SettingsPanel` (the tab nav + the mounted page) is passed in as `children`
 * rather than imported here, so this file stays pure shell mechanics.
 */
export function SettingsModal({
  label, onClose, children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<Element | null>(null);
  const pressedOnBackdrop = useRef(false);

  useEffect(() => {
    // Focus moves in on open, and back out on close. A keyboard user who
    // opened settings from the sidebar's gear button is never dropped back
    // at the top of the page — they land exactly where they were.
    // `SettingsPanel` renders the actual visible close button (`.settings-close`
    // in its header); this shell queries for it rather than duplicating a
    // second, hidden one just to hold a ref.
    openerRef.current = document.activeElement;
    cardRef.current?.querySelector<HTMLButtonElement>('.settings-close')?.focus();
    return () => {
      const opener = openerRef.current as HTMLElement | null;
      // The opener can be gone from the DOM by the time this runs (e.g. the
      // sidebar re-rendered while settings was open), so this is guarded
      // rather than assumed.
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const stackedSurfaceOpen =
        document.querySelector('.modal-backdrop:not(.settings-backdrop), .context-menu') !== null;
      if (shouldCloseOnEscape(stackedSurfaceOpen)) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      ref={backdropRef}
      className="modal-backdrop settings-backdrop"
      onMouseDown={(e) => { pressedOnBackdrop.current = e.target === backdropRef.current; }}
      onMouseUp={(e) => {
        const close = shouldCloseOnBackdropClick(pressedOnBackdrop.current, e.target === backdropRef.current);
        pressedOnBackdrop.current = false;
        if (close) onClose();
      }}
    >
      <div ref={cardRef} className="settings-modal" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Does this Esc keypress belong to us, or to a surface stacked above us?
 *
 * Nothing in this console currently renders a `.modal-backdrop` or
 * `.context-menu` on top of this one — `Sources.tsx`'s archive/remove confirm
 * and `Runs.tsx`'s revert confirm are both inline two-click confirmations
 * (a first click that probes and gets `confirmation_required` back, a second
 * that confirms), not a modal, a backdrop, or a `role="dialog"` surface. This
 * guard is inert today. It stays anyway, at the cost of two lines, so that
 * the first surface to actually stack above settings does not silently break
 * Esc: without this check, that surface's Esc handler and this modal's would
 * both fire on the same keypress, closing settings out from under it.
 */
export function shouldCloseOnEscape(stackedSurfaceOpen: boolean): boolean {
  return !stackedSurfaceOpen;
}

/**
 * Did this click start AND end on the backdrop itself?
 *
 * A plain `click` handler on the backdrop is not enough: selecting text in a
 * settings field and dragging the mouse-up past the card's edge fires a
 * `click` whose target is the backdrop, even though the press began inside
 * the card. Tracking press and release separately — and requiring both to
 * land on the backdrop, not merely somewhere outside the card — is what
 * keeps that drag from silently closing the dialog on top of the operator's
 * in-progress selection.
 */
export function shouldCloseOnBackdropClick(pressedBackdrop: boolean, targetIsBackdrop: boolean): boolean {
  return pressedBackdrop && targetIsBackdrop;
}
