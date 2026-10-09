import { test, expect, describe } from 'bun:test';
import { parseRoute, routeToPath, legacyRedirect, goTo, type Route } from '../../src/console/router.ts';

/**
 * App.tsx (`pageFromPath`, `App.tsx:63-72`) read `window.location.pathname`
 * once at mount and never wrote it back: clicking a nav item never touched
 * the URL, deep links only worked on cold load, and the back button did
 * nothing. `router.ts` replaces that with a pure parse/format pair plus
 * legacy redirects, so every assertion here is a URL that must keep working
 * — not a rendering detail.
 */

describe('parseRoute: every row of the URL table', () => {
  test('root with no Source chosen yet', () => {
    expect(parseRoute('/')).toEqual({ kind: 'editor', sourceId: null, path: null });
  });

  test('a Source with no file open', () => {
    expect(parseRoute('/s/my-brain')).toEqual({ kind: 'editor', sourceId: 'my-brain', path: null });
  });

  test('a Source with a nested file path, internal slashes preserved', () => {
    expect(parseRoute('/s/my-brain/product/specs/auth.md'))
      .toEqual({ kind: 'editor', sourceId: 'my-brain', path: 'product/specs/auth.md' });
  });

  test('a settings tab', () => {
    expect(parseRoute('/settings/members')).toEqual({ kind: 'settings', tab: 'members' });
  });

  test('a claim token', () => {
    expect(parseRoute('/claim/abc123')).toEqual({ kind: 'claim', token: 'abc123' });
  });

  test('the living style guide', () => {
    // A real route, not a dev-only flag: with no DOM test harness in this repo,
    // rendering every primitive in both themes is the only way visual parity
    // gets reviewed at all.
    expect(parseRoute('/design-system')).toEqual({ kind: 'design' });
  });

  test('an unrecognised settings tab falls back to the editor root rather than throwing', () => {
    // A stray URL must never turn into a white screen. `isSettingsTab` is
    // what draws this line, not a hand-rolled check against SETTINGS_TABS.
    expect(parseRoute('/settings/nope')).toEqual({ kind: 'editor', sourceId: null, path: null });
  });

  test('/settings with no tab segment also falls back, not to an empty settings route', () => {
    expect(parseRoute('/settings')).toEqual({ kind: 'editor', sourceId: null, path: null });
  });

  test('an entirely unknown path parses as the editor root, not a throw', () => {
    // A router that throws on a typo turns it into a white screen.
    expect(parseRoute('/nope/nothing/here')).toEqual({ kind: 'editor', sourceId: null, path: null });
  });
});

describe('parseRoute: trailing slashes are the same route', () => {
  test('a trailing slash on a Source path does not create a phantom empty segment', () => {
    expect(parseRoute('/s/my-brain/')).toEqual({ kind: 'editor', sourceId: 'my-brain', path: null });
  });

  test('a trailing slash on the root is still the root', () => {
    expect(parseRoute('//')).toEqual({ kind: 'editor', sourceId: null, path: null });
  });
});

describe('parseRoute: encoding round-trips through the URL', () => {
  test('a file path containing a space survives encode/decode', () => {
    const route = parseRoute('/s/my-brain/notes/meeting%20notes.md');
    expect(route).toEqual({ kind: 'editor', sourceId: 'my-brain', path: 'notes/meeting notes.md' });
  });

  test('a file path containing a # survives encode/decode', () => {
    // A bare # in the pathname would be read as a fragment by a real browser,
    // so routeToPath must percent-encode it — this asserts parseRoute can
    // read that encoded form back correctly.
    const route = parseRoute('/s/my-brain/todo%23list.md');
    expect(route).toEqual({ kind: 'editor', sourceId: 'my-brain', path: 'todo#list.md' });
  });
});

describe('parseRoute never touches window when given an argument', () => {
  test('a string argument is used as-is, with no fallback to window.location', () => {
    // If this reached into `window` despite being given a path, it would
    // throw in this test environment (no DOM here) or silently ignore the
    // argument. Getting `'/'` back for a totally unrelated path would mean
    // the argument was ignored.
    expect(parseRoute('/s/only-this-argument-matters')).toEqual({
      kind: 'editor', sourceId: 'only-this-argument-matters', path: null,
    });
  });
});

describe('routeToPath is parseRoute\'s exact inverse', () => {
  test('round-trips every route shape', () => {
    const routes: Route[] = [
      { kind: 'editor', sourceId: null, path: null },
      { kind: 'editor', sourceId: 'my-brain', path: null },
      { kind: 'editor', sourceId: 'my-brain', path: 'product/specs/auth.md' },
      { kind: 'settings', tab: 'members' },
      { kind: 'settings', tab: 'sources' },
      { kind: 'claim', token: 'abc123' },
      { kind: 'design' },
    ];
    for (const r of routes) expect(parseRoute(routeToPath(r))).toEqual(r);
  });

  test('round-trips a file path with a space', () => {
    const r: Route = { kind: 'editor', sourceId: 'my-brain', path: 'notes/meeting notes.md' };
    expect(parseRoute(routeToPath(r))).toEqual(r);
  });

  test('round-trips a file path with a #', () => {
    const r: Route = { kind: 'editor', sourceId: 'my-brain', path: 'todo#list.md' };
    expect(parseRoute(routeToPath(r))).toEqual(r);
    // And the produced URL must actually encode the #, not carry it raw —
    // a raw # would be parsed as a fragment by a real browser.
    expect(routeToPath(r)).not.toContain('#list.md');
  });

  test('a Source id with no file open formats without a trailing slash', () => {
    expect(routeToPath({ kind: 'editor', sourceId: 'my-brain', path: null })).toBe('/s/my-brain');
  });
});

describe('legacyRedirect: bookmarked cold-load routes survive', () => {
  test('the five admin pages redirect into settings', () => {
    expect(legacyRedirect('/sources')).toBe('/settings/sources');
    expect(legacyRedirect('/schedules')).toBe('/settings/schedules');
    expect(legacyRedirect('/runs')).toBe('/settings/runs');
    expect(legacyRedirect('/spend')).toBe('/settings/spend');
    expect(legacyRedirect('/upgrades')).toBe('/settings/upgrades');
  });

  test('a trailing slash is the same route', () => {
    expect(legacyRedirect('/sources/')).toBe('/settings/sources');
  });

  test('/files redirects to the editor root, not to a settings tab', () => {
    expect(legacyRedirect('/files')).toBe('/');
  });

  test('a route that needs no redirect answers null', () => {
    expect(legacyRedirect('/design-system')).toBeNull();
    expect(legacyRedirect('/s/my-brain')).toBeNull();
    expect(legacyRedirect('/settings/members')).toBeNull();
    expect(legacyRedirect('/')).toBeNull();
  });

  test('the bookmark property parseRoute alone cannot give: /settings/sources parses AND /sources still lands there', () => {
    expect(parseRoute('/settings/sources')).toEqual({ kind: 'settings', tab: 'sources' });
    expect(legacyRedirect('/sources')).toBe(routeToPath(parseRoute('/settings/sources')));
  });
});

describe('goTo', () => {
  test('pushes the settings path and fires popstate so the shell re-parses', () => {
    const g = globalThis as any;
    const saved = { window: g.window, PopStateEvent: g.PopStateEvent };
    const pushed: string[] = [];
    const events: string[] = [];
    g.PopStateEvent = class { type = 'popstate'; };
    g.window = {
      history: { pushState: (_s: unknown, _t: string, url: string) => pushed.push(url) },
      dispatchEvent: (e: { type: string }) => { events.push(e.type); return true; },
    };
    try {
      goTo({ kind: 'settings', tab: 'credentials' });
    } finally {
      g.window = saved.window; g.PopStateEvent = saved.PopStateEvent;
    }
    expect(pushed).toEqual(['/settings/credentials']);
    expect(events).toEqual(['popstate']);
    expect(parseRoute('/settings/credentials')).toEqual({ kind: 'settings', tab: 'credentials' });
  });
});
