import { Dialog, shouldCloseOnEscape, shouldCloseOnBackdropClick } from '../ui/index.tsx';

/**
 * The settings modal's shell, now that the shell itself is `ui/Dialog` — the
 * same code, with the settings modal as its first caller instead of its only
 * possible one. Every mechanic moved across unchanged (press-and-release
 * backdrop check, stacked-surface Esc deferral, focus restore to the opener,
 * opacity-only animation and the containing-block reason for it); the reasons
 * they exist moved with them and are documented on `Dialog`.
 *
 * Phase 2 looked at collapsing this file into `ui/Dialog` and kept it. The
 * seam costs one indirection and buys two things. `AppShell.tsx` names a
 * settings modal, not a generic dialog, so the shell keeps reading as what it
 * is. And `test/unit/console-settings-modal.test.ts` asserts the two
 * predicates HERE, at the path the shell actually imports — which is the only
 * place an assertion proves the shell's Esc and click-away behaviour rather
 * than some other caller's. Moving the test's import to `ui/` would make it a
 * test of the primitive and leave the settings modal itself unasserted.
 *
 * So the re-export is load-bearing, not vestigial. `Dialog` supports every
 * mechanic this modal needs, and nothing in it was restructured.
 */
export function SettingsModal({
  label, onClose, children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog label={label} onClose={onClose}>
      {children}
    </Dialog>
  );
}

export { shouldCloseOnEscape, shouldCloseOnBackdropClick };
