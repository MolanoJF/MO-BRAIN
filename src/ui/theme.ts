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
 * Dark iff the class attribute carries `dark`. Split on whitespace rather than
 * a substring test, so a future `darkroom-banner` class cannot answer this.
 *
 * `.light` is deliberately not consulted. `applyTheme` always writes exactly
 * one of the two, and when neither is there — the first paint, before any
 * script has run — `tokens.css` is serving the bare `:root` block, which IS the
 * light theme. "No class" and "light" are the same answer, so `dark` is the
 * only class that changes it.
 */
export function isDarkClassName(className: string): boolean {
  return className.split(/\s+/).includes('dark');
}

/** What the page is painting right now, read off the class `applyTheme` writes.
 *  Safe to call before any choice has been applied. */
export function isDarkNow(): boolean {
  if (typeof document === 'undefined') return false;
  return isDarkClassName(document.documentElement.className);
}

/**
 * Subscribe to theme flips.
 *
 * `applyTheme` toggles a class imperatively, so a theme change is invisible to
 * React — nothing re-renders for it, and nothing needs to, because every other
 * surface in the console is painted by CSS that re-resolves on its own. The
 * exception is a surface that has to be TOLD its colour scheme rather than
 * shown it: the CodeMirror editor (see `editor/theme.ts`).
 *
 * This lives here, next to the code that writes the class, rather than in the
 * page that needed it first: a page component is the wrong owner of a
 * document-wide observer, and the second consumer would otherwise hand-roll a
 * second one that observes the same attribute.
 *
 * It fires only on a real transition. `applyTheme` rewrites both classes on
 * every call, including the many calls that change nothing (a `storage` event
 * from another tab, an OS flip while an explicit choice is selected), and a
 * subscriber that rebuilt itself on each of those would be paying for noise.
 */
export function watchTheme(onChange: (dark: boolean) => void): () => void {
  const root = document.documentElement;
  let last = isDarkClassName(root.className);
  const observer = new MutationObserver(() => {
    const next = isDarkClassName(root.className);
    if (next === last) return;
    last = next;
    onChange(next);
  });
  observer.observe(root, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
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
