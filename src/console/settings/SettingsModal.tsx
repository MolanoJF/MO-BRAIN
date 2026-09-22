import { Dialog, shouldCloseOnEscape, shouldCloseOnBackdropClick } from '../ui/index.tsx';

/**
 * The settings modal's shell, now that the shell itself is `ui/Dialog` — the
 * same code, with the settings modal as its first caller instead of its only
 * possible one. Every mechanic moved across unchanged (press-and-release
 * backdrop check, stacked-surface Esc deferral, focus restore to the opener,
 * opacity-only animation and the containing-block reason for it); the reasons
 * they exist moved with them and are documented on `Dialog`.
 *
 * This file stays as a thin pass-through rather than disappearing today,
 * because `AppShell.tsx` and `test/unit/console-settings-modal.test.ts` both
 * name this path, and re-pointing them belongs to Phase 2 along with the rest
 * of the shell. The two predicates are re-exported for the same reason: the
 * test asserts them here, and a test that moves in the same commit as its
 * subject proves nothing about the move.
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
