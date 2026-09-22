import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { badgeClass, buttonClass, fieldClass, toneClass, type ButtonVariant, type Tone } from './classes.ts';

/**
 * The console's primitives — one module, mirroring `qm/plugins/admin/ui/shared.ts`
 * rather than a `components/` tree, because there are a dozen of these and a
 * dozen files to hold them is a filing system, not an abstraction.
 *
 * Everything here is a thin wrapper. The styling decisions live in
 * `./classes.ts`, which is pure and unit-tested; nothing in this file decides
 * anything a test would want to assert, which is deliberate — this repo has no
 * DOM harness (no jsdom, no testing-library), so a decision made in a
 * component is a decision no test can reach.
 *
 * Specs are qm's, from `qm/plugins/admin/public/admin-components.css` and the
 * base rules in `qm/plugins/admin/public/index.html`.
 */

export { badgeClass, buttonClass, fieldClass, toneClass };
export type { ButtonVariant, Tone };
export { Icon } from './Icon.tsx';

/* ------------------------------------------------------------------ Button */

export function Button({
  variant = 'secondary', className, type = 'button', children, ...rest
}: {
  variant?: ButtonVariant;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={buttonClass(variant, className)} {...rest}>
      {children}
    </button>
  );
}

/**
 * An icon-only button, square on the control height so a row of them lines up
 * with the text controls beside them. `label` is required and becomes
 * `aria-label`: the glyph itself is `aria-hidden` (see `Icon`), so without it
 * the button announces as nothing at all.
 */
export function IconButton({
  label, className, type = 'button', children, ...rest
}: {
  label: string;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base =
    'inline-flex items-center justify-center h-[var(--control-height)] w-[var(--control-height)] ' +
    'rounded-[var(--control-radius)] border border-border bg-surface text-text ' +
    'enabled:hover:bg-subtle disabled:opacity-45 disabled:cursor-not-allowed';
  return (
    <button type={type} aria-label={label} title={label} className={className ? `${base} ${className}` : base} {...rest}>
      {children}
    </button>
  );
}

/**
 * The press-twice confirmation, as one primitive instead of the three hand-rolled
 * copies in `Schedules.tsx`, `Sources.tsx` and `Runs.tsx`. Arming is local and
 * disappears on blur: an armed destructive button left sitting in the page is a
 * trap for whoever clicks it next, and the operator who walked away from it is
 * exactly the person who will not remember it is armed.
 */
export function ConfirmButton({
  label, confirmLabel, onConfirm, variant = 'danger', className, disabled,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  variant?: ButtonVariant;
  className?: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      variant={variant}
      className={className}
      disabled={disabled}
      aria-live="polite"
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

/* ------------------------------------------------------------------- Field */

/**
 * A labelled control. qm's label is `13px/400` with `margin-bottom: 4px` and
 * its hint is the same size in `--muted`; the error, when present, replaces the
 * hint rather than stacking under it, because two lines of small text under one
 * input is where people stop reading.
 *
 * `invalid` drives both the border colour and `aria-invalid` from one prop, so
 * the two can never disagree — a red border a screen reader cannot see is not
 * an error message.
 */
export function Field({
  label, hint, error, id, children, className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `flex flex-col ${className}` : 'flex flex-col'}>
      {label !== undefined && (
        <label htmlFor={id} className="mb-1 text-[length:var(--control-font)] font-normal leading-[1.4] text-text">
          {label}
        </label>
      )}
      {children}
      {error !== undefined ? (
        <p className="mt-1 text-[length:var(--control-font)] font-normal leading-[1.5] text-danger">{error}</p>
      ) : hint !== undefined ? (
        <p className="mt-1 text-[length:var(--control-font)] font-normal leading-[1.5] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({
  invalid, className, ...rest
}: { invalid?: boolean; className?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const base = fieldClass(invalid);
  return <input aria-invalid={invalid || undefined} className={className ? `${base} ${className}` : base} {...rest} />;
}

export function Select({
  invalid, className, children, ...rest
}: { invalid?: boolean; className?: string } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const base = fieldClass(invalid);
  return (
    <select aria-invalid={invalid || undefined} className={className ? `${base} ${className}` : base} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({
  invalid, className, ...rest
}: { invalid?: boolean; className?: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  // qm gives textareas a 90px floor and vertical-only resize: a horizontally
  // resizable textarea escapes the card it sits in.
  const base = `${fieldClass(invalid)} min-h-[90px] resize-y`;
  return <textarea aria-invalid={invalid || undefined} className={className ? `${base} ${className}` : base} {...rest} />;
}

/* -------------------------------------------------------------------- Card */

/**
 * qm's card: `padding: 18px` with `padding-block: var(--section-gap)`, a
 * hairline border, `--radius`, on `--surface`.
 *
 * qm's own rule also carries `margin: 0 0 22px`. That is left off here on
 * purpose — a primitive that owns its outer margin cannot be laid out by its
 * container, and every page in this console stacks cards in a flex/gap column.
 */
export function Card({
  title, subtitle, head, foot, footEnd = false, className, children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  head?: ReactNode;
  foot?: ReactNode;
  /** qm right-aligns a footer that holds a primary action. */
  footEnd?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const base = 'px-[18px] py-[var(--section-gap)] border border-border rounded-[var(--radius)] bg-surface';
  return (
    <section className={className ? `${base} ${className}` : base}>
      {(title !== undefined || subtitle !== undefined || head !== undefined) && (
        <div className="mb-3">
          {title !== undefined && (
            <h2 className="m-0 text-[length:var(--section-font)] font-medium leading-[1.5] text-text">{title}</h2>
          )}
          {subtitle !== undefined && (
            <p className="mt-1 max-w-[70ch] text-[length:var(--control-font)] font-normal leading-[1.5] text-muted">
              {subtitle}
            </p>
          )}
          {head}
        </div>
      )}
      {children}
      {foot !== undefined && (
        <div
          className={
            footEnd
              ? 'mt-4 flex flex-wrap items-center justify-end gap-[var(--control-gap)]'
              : 'mt-4 flex flex-wrap items-center gap-[var(--control-gap)]'
          }
        >
          {foot}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------- Badge */

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={badgeClass(tone)}>{children}</span>;
}

/* ------------------------------------------------------------------- Table */

/**
 * `overflow-x: auto` with `overscroll-behavior-x: contain`, so a sideways
 * scroll inside a wide table does not turn into a browser back-navigation
 * gesture halfway through reading a row.
 */
export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  const base = 'w-full max-w-full overflow-x-auto overscroll-x-contain';
  return <div className={className ? `${base} ${className}` : base}>{children}</div>;
}

/**
 * qm styles bare `th`/`td` globally; this repo cannot, so the same declarations
 * are attached as descendant variants on the table itself. That keeps `Table`
 * one component rather than forcing every call site to import a `Th` and a `Td`
 * and remember to use them — the version of this that relies on remembering is
 * the version where one page's table ends up 2px out of step with every other.
 */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  const base =
    'w-full border-collapse text-[length:var(--control-font)] ' +
    '[&_th]:px-3 [&_th]:py-2.5 [&_th]:text-left [&_th]:text-xs [&_th]:font-normal ' +
    '[&_th]:leading-[1.4] [&_th]:text-muted [&_th]:border-b [&_th]:border-border ' +
    '[&_td]:p-3 [&_td]:leading-[1.4] [&_td]:border-b [&_td]:border-border';
  return <table className={className ? `${base} ${className}` : base}>{children}</table>;
}

/* ------------------------------------------------- Empty / Notice / Toolbar */

/** qm's `.empty`: left-aligned, never centred — a centred empty state reads as
 *  a failure, where a quiet line of muted text reads as "nothing here yet". */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-4 text-left text-[length:var(--control-font)] text-muted">{children}</p>;
}

/**
 * The standing warning card, which is what the 21 `.card border-warning` call
 * sites actually are. `warning` uses qm's dedicated `--warn-surface` /
 * `--warn-border` / `--warn-text` triple — a real third colour per theme, not a
 * tint of the text colour — because a warning has to stay legible against both
 * a white and a near-black page. Every other tone tints from its own colour,
 * the same mechanic as `Badge`.
 */
export function Notice({ tone = 'warning', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  const shape = 'flex items-start gap-2.5 rounded-[var(--radius)] border px-4 py-3.5 text-[length:var(--control-font)] font-normal leading-[1.5]';
  const skin =
    tone === 'warning'
      ? 'bg-warn-surface border-warn-border text-warn-text'
      : `bg-current/7 border-current/14 ${toneClass(tone)}`;
  return <div className={className ? `${shape} ${skin} ${className}` : `${shape} ${skin}`}>{children}</div>;
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  const base = 'flex flex-wrap items-center gap-[var(--control-gap)]';
  return <div className={className ? `${base} ${className}` : base}>{children}</div>;
}

/**
 * A busy indicator, `aria-hidden` because the surface that owns it is what
 * should be announcing its state — a spinner that announces itself says
 * "loading" forever to a screen reader and never says it stopped.
 */
export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block animate-spin rounded-full border-2 border-border border-t-cta"
      style={{ width: size, height: size }}
    />
  );
}

/* ------------------------------------------------------------------ Dialog */

/**
 * A modal shell: a backdrop and a card, portalled to `<body>`.
 *
 * This is `settings/SettingsModal.tsx` generalized, and every mechanic below is
 * carried over unchanged — each one exists because a simpler version of it
 * broke something in production, and the reason is kept here rather than left
 * to be rediscovered. The only thing Phase 1 changed is who can call it.
 *
 * The class-name defaults are the settings modal's because it is still the only
 * caller; the CSS in `styles.css` is already the generic modal shell in
 * everything but its name, and gets renamed when the last caller moves.
 */
export function Dialog({
  label, onClose, children,
  backdropClass = 'modal-backdrop settings-backdrop',
  cardClass = 'settings-modal',
  initialFocus = '.settings-close',
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  backdropClass?: string;
  cardClass?: string;
  /** A selector, resolved inside the card. The caller renders the visible close
   *  button, so this shell finds it rather than duplicating a hidden one. */
  initialFocus?: string;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<Element | null>(null);
  const pressedOnBackdrop = useRef(false);

  useEffect(() => {
    // Focus moves in on open, and back out on close. A keyboard user who
    // opened settings from the sidebar's gear button is never dropped back
    // at the top of the page — they land exactly where they were.
    openerRef.current = document.activeElement;
    cardRef.current?.querySelector<HTMLElement>(initialFocus)?.focus();
    return () => {
      const opener = openerRef.current as HTMLElement | null;
      // The opener can be gone from the DOM by the time this runs (e.g. the
      // sidebar re-rendered while settings was open), so this is guarded
      // rather than assumed.
      if (opener?.isConnected) opener.focus();
    };
  }, [initialFocus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // "Is a surface stacked above us?" — asked by node identity rather than
      // by the `.modal-backdrop:not(.settings-backdrop)` class literal this
      // check used while there was exactly one dialog in the console. For that
      // single caller the two are the same query; for two dialogs they are
      // not, and the class version would have let both close on one keypress
      // — the very failure the guard was written to prevent.
      const stackedSurfaceOpen = Array.from(document.querySelectorAll('.modal-backdrop, .context-menu'))
        .some((el) => el !== backdropRef.current);
      if (shouldCloseOnEscape(stackedSurfaceOpen)) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      ref={backdropRef}
      className={backdropClass}
      onMouseDown={(e) => { pressedOnBackdrop.current = e.target === backdropRef.current; }}
      onMouseUp={(e) => {
        const close = shouldCloseOnBackdropClick(pressedOnBackdrop.current, e.target === backdropRef.current);
        pressedOnBackdrop.current = false;
        if (close) onClose();
      }}
    >
      <div ref={cardRef} className={cardClass} role="dialog" aria-modal="true" aria-label={label}>
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
 * `.context-menu` on top of the settings modal — `Sources.tsx`'s archive/remove
 * confirm and `Runs.tsx`'s revert confirm are both inline two-click
 * confirmations (a first click that probes and gets `confirmation_required`
 * back, a second that confirms), not a modal, a backdrop, or a `role="dialog"`
 * surface. This guard is inert today. It stays anyway, at the cost of two
 * lines, so that the first surface to actually stack above a dialog does not
 * silently break Esc: without this check, that surface's Esc handler and the
 * dialog's would both fire on the same keypress, closing the dialog out from
 * under it.
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
