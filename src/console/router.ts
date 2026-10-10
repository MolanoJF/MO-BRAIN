import { useEffect, useState } from 'react';
import { encodePath } from './api.ts';
import { type SettingsTab, isSettingsTab, settingsTabForSegment } from './settings/tabs.ts';

/**
 * The SPA's real routes. This module replaces `pageFromPath` and
 * `claimTokenFromPath` (`App.tsx:63-78`), which read `window.location.pathname`
 * once at mount and never wrote it back: clicking a nav item never touched
 * the URL, deep links only worked on cold load, and the back button did
 * nothing. `parseRoute` and `routeToPath` are pure — no DOM, no React — so
 * they are testable without a browser; only `useRoute()` below touches
 * `window`/`history`.
 */
export type Route =
  | { kind: 'editor'; sourceId: string | null; path: string | null }
  | { kind: 'settings'; tab: SettingsTab }
  | { kind: 'claim'; token: string }
  | { kind: 'design' };

/** A trailing slash (or several) is the same route as without one. */
function normalize(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Decode each `/`-separated segment independently — the inverse of `encodePath`. */
function decodePath(encoded: string): string {
  return encoded.split('/').map(decodeURIComponent).join('/');
}

/**
 * Parses a pathname into a `Route`. Pure: given a string, it never reads
 * `window`. The default argument only evaluates `window.location.pathname`
 * when the caller omits the argument entirely — every test in
 * `test/unit/console-router.test.ts` passes a string, so none of them touch
 * `window`.
 *
 * An unrecognised path — a typo, a removed route, a settings tab a caller's
 * role can no longer see — falls back to the editor root rather than
 * throwing. A router that throws on a stray URL turns a typo into a white
 * screen. (Role-based fallback among *valid* tabs is `resolveTab`'s job in
 * `settings/tabs.ts`, not this parser's — `parseRoute` does not know about
 * roles.)
 */
export function parseRoute(pathname: string = window.location.pathname): Route {
  const path = normalize(pathname);

  // The living style guide (`pages/DesignSystem.tsx`), at qm's own path. It
  // is a real route rather than a dev-only toggle because it is how visual
  // parity gets reviewed at all: this repo has no DOM test harness, so the
  // only way to see every primitive in both themes is to render them.
  if (path === '/design-system') return { kind: 'design' };

  const claim = path.match(/^\/claim\/([^/]+)$/);
  if (claim) return { kind: 'claim', token: decodeURIComponent(claim[1]!) };

  const settings = path.match(/^\/settings\/([^/]+)$/);
  if (settings) {
    const tab = decodeURIComponent(settings[1]!);
    const resolved = settingsTabForSegment(tab);
    if (resolved) return { kind: 'settings', tab: resolved };
    return { kind: 'editor', sourceId: null, path: null };
  }
  if (path === '/settings') return { kind: 'editor', sourceId: null, path: null };

  const withPath = path.match(/^\/s\/([^/]+)\/(.+)$/);
  if (withPath) {
    return {
      kind: 'editor',
      sourceId: decodeURIComponent(withPath[1]!),
      path: decodePath(withPath[2]!),
    };
  }

  const sourceOnly = path.match(/^\/s\/([^/]+)$/);
  if (sourceOnly) return { kind: 'editor', sourceId: decodeURIComponent(sourceOnly[1]!), path: null };

  return { kind: 'editor', sourceId: null, path: null };
}

/**
 * `parseRoute`'s exact inverse: `parseRoute(routeToPath(r))` equals `r` for
 * every shape (asserted in the test file). File paths are percent-encoded
 * segment by segment via `encodePath` (`api.ts`) — the same helper the wire
 * client uses to build `PUT /spaces/:id/files/:path` — so a path containing
 * a space or a `#` survives the round trip instead of a `#` being read as a
 * URL fragment by the browser.
 */
export function routeToPath(route: Route): string {
  if (route.kind === 'design') return '/design-system';
  if (route.kind === 'claim') return `/claim/${encodeURIComponent(route.token)}`;
  if (route.kind === 'settings') return `/settings/${route.tab}`;
  if (route.sourceId === null) return '/';
  if (route.path === null) return `/s/${encodeURIComponent(route.sourceId)}`;
  return `/s/${encodeURIComponent(route.sourceId)}/${encodePath(route.path)}`;
}

/**
 * Every cold-load route the old `pageFromPath` served directly, mapped into
 * the shell's new URLs. REQUIRED, not cosmetic: `/sources`, `/schedules`,
 * `/runs`, `/spend`, `/upgrades` and `/files` are live routes today
 * (`test/unit/console-app.test.ts`) and somebody has at least one
 * bookmarked. Returns `null` when the given path is already current and
 * needs no redirect.
 */
export function legacyRedirect(pathname: string): string | null {
  const path = normalize(pathname);
  const toSettingsTab: Record<string, SettingsTab> = {
    '/sources': 'sources',
    '/schedules': 'schedules',
    '/runs': 'runs',
    // Spend and upgrades are sections of General now, not tabs.
    '/spend': 'general',
    '/upgrades': 'general',
  };
  if (path in toSettingsTab) return `/settings/${toSettingsTab[path]}`;
  const settings = path.match(/^\/settings\/([^/]+)$/);
  if (settings) {
    const segment = decodeURIComponent(settings[1]!);
    const mapped = settingsTabForSegment(segment);
    // A retired id maps to a different live tab. A live id is already current.
    if (mapped && !isSettingsTab(segment)) return `/settings/${mapped}`;
  }
  if (path === '/files') return '/';
  return null;
}

/**
 * The only part of this module that touches `window`/`history`. It is kept
 * to a thin wrapper over `parseRoute`/`routeToPath` on purpose: this repo
 * has no DOM test harness (no happy-dom, no jsdom, no testing-library), so
 * `useRoute` itself is not unit-tested — everything decidable without a
 * browser lives in the pure functions above, which are.
 */
export function useRoute(): { route: Route; navigate: (route: Route, opts?: { replace?: boolean }) => void } {
  const [route, setRoute] = useState<Route>(() => parseRoute());

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = (next: Route, opts?: { replace?: boolean }) => {
    const path = routeToPath(next);
    if (opts?.replace) {
      window.history.replaceState(null, '', path);
    } else {
      window.history.pushState(null, '', path);
    }
    setRoute(next);
  };

  return { route, navigate };
}
