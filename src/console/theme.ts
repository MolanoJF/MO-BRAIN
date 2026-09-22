/**
 * Light / dark / system, ported from qm's `plugins/web-ui/src/settings.ts` and
 * the admin toggle at `qm/plugins/admin/public/index.html:6591-6600`.
 *
 * The split here is the same one `router.ts` and `App.tsx` use: the decision is
 * a pure function so `test/unit/console-ui.test.ts` can assert it with no
 * browser, and only the two functions below it touch `document` or
 * `localStorage`. This repo has no DOM harness, so anything decided inside a
 * `document` call is a decision no test can reach.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';

/** The storage key is qm's, unprefixed, so a deployment serving both consoles
 *  on one origin agrees with itself about the operator's choice. */
const THEME_KEY = 'theme';

/**
 * Should the page be dark? An explicit choice always beats the OS — that is
 * the entire reason a switcher exists, and the bug it guards against is the
 * one where `system` is treated as a fallback rather than as a third answer,
 * so a user who picked Light gets dark anyway at night.
 */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): boolean {
  if (choice === 'dark') return true;
  if (choice === 'light') return false;
  return prefersDark;
}

/** Anything unrecognised in storage reads as `system`, including nothing at
 *  all. `localStorage` itself can throw (Safari private mode, a blocked
 *  third-party frame), so every access here is guarded. */
export function storedTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Storage unavailable. `system` is the right answer, not an error.
  }
  return 'system';
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Both classes are toggled, not just `.dark`, exactly as qm does. `.dark` is
 * what the tokens and the Tailwind `dark:` variant key off; `.light` is what
 * lets a rule say "only in light mode" without having to spell it as
 * `:not(.dark)`, which cannot be written as a Tailwind variant selector.
 */
export function applyTheme(choice: ThemeChoice): void {
  const dark = resolveTheme(choice, prefersDark());
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.classList.toggle('light', !dark);
}

export function setTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    // The choice still applies to this tab; it just will not survive a reload.
  }
  applyTheme(choice);
}

/**
 * Keeps `system` honest. Two listeners, because there are two ways the right
 * answer changes without this tab doing anything:
 *
 *  - the OS flips (sunset, or a manual switch) while `system` is selected;
 *  - another tab of this console picks a theme, which arrives as a `storage`
 *    event and must not leave the two tabs disagreeing.
 *
 * Returns its own teardown so a caller in a component could unsubscribe;
 * `main.tsx` calls it once for the life of the page and ignores the result.
 */
export function watchSystemTheme(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onMedia = () => { if (storedTheme() === 'system') applyTheme('system'); };
  const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === THEME_KEY) applyTheme(storedTheme()); };
  media.addEventListener('change', onMedia);
  window.addEventListener('storage', onStorage);
  return () => {
    media.removeEventListener('change', onMedia);
    window.removeEventListener('storage', onStorage);
  };
}
