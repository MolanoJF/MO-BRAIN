import { test, expect, describe } from 'bun:test';
import { pickSource, readRememberedSource, rememberSource } from '../../src/console/SourceContext.tsx';
import type { SpaceSummary } from '../../src/console/api.ts';

/**
 * The console's one app-wide Source selection. Before this, Files.tsx:181 held
 * `sourceId` in a local `useState('')` that died on every page switch, and no
 * other page shared it. `pickSource` is the resolution rule, kept pure and
 * separate from `SourceProvider` on purpose: this repo has no DOM test harness
 * (no happy-dom, jsdom, or testing-library), so everything decidable about
 * Source selection has to be decidable without mounting anything.
 */

const space = (sourceId: string): SpaceSummary => ({ id: sourceId, sourceId, name: sourceId, access: 'write' });

describe('pickSource — URL wins, then the remembered id, then the first entry, then null', () => {
  const spaces = [space('a'), space('b')];

  test('the URL Source wins even over a remembered one', () => {
    expect(pickSource(spaces, 'b', 'a')).toEqual(space('b'));
  });

  test('a remembered Source is used when the URL names none', () => {
    expect(pickSource(spaces, null, 'b')).toEqual(space('b'));
  });

  test('the first Source is used when neither the URL nor the remembered id says', () => {
    expect(pickSource(spaces, null, null)).toEqual(space('a'));
  });

  test('a stale remembered Source (archived, or DELETEd) is discarded without error, falling through to the first entry', () => {
    expect(pickSource(spaces, null, 'gone')).toEqual(space('a'));
  });

  test('a URL Source that no longer exists falls through to the remembered one rather than returning null', () => {
    // The regression this guards: a bookmarked or shared link naming a Source
    // that was archived after the link was made must not strand the operator
    // on an empty screen when they still have a working preference.
    expect(pickSource(spaces, 'gone', 'b')).toEqual(space('b'));
  });

  test('a remembered id no longer present falls through to the first entry, not null', () => {
    expect(pickSource(spaces, null, 'gone')).toEqual(space('a'));
  });

  test('zero Sources is null for every input, never a throw', () => {
    expect(pickSource([], null, null)).toBeNull();
    expect(pickSource([], 'a', null)).toBeNull();
    expect(pickSource([], null, 'a')).toBeNull();
    expect(pickSource([], 'a', 'b')).toBeNull();
  });

  test('the returned Source is the actual array element, not a copy', () => {
    // setCurrent and the rest of the app key off identity in a few places
    // (e.g. React's own reconciliation); pickSource must hand back the same
    // object reference the caller's array holds, not a structurally-equal one.
    const target = spaces[1]!;
    expect(pickSource(spaces, 'b', null)).toBe(target);
  });

  test('both URL and remembered unknown falls all the way through to the first entry', () => {
    expect(pickSource(spaces, 'gone', 'also-gone')).toEqual(space('a'));
  });
});

describe('readRememberedSource / rememberSource — guarded localStorage, fallback only', () => {
  // There is no DOM harness here, so the DOM-backed path (an actual
  // window.localStorage) is not under test — only the pure fallback behaviour
  // the try/catch guarantees when localStorage throws or is absent, which is
  // exactly the private-window / blocked-site-data / embedded-webview case
  // this guard exists for.

  test('reading with no localStorage available returns null rather than throwing', () => {
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    // Deliberately removing the global to simulate a private-window /
    // blocked-site-data environment.
    delete (globalThis as { localStorage?: unknown }).localStorage;
    try {
      expect(readRememberedSource()).toBeNull();
    } finally {
      if (original !== undefined) (globalThis as { localStorage?: unknown }).localStorage = original;
    }
  });

  test('writing with no localStorage available is swallowed, not thrown', () => {
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    // Same simulated environment as above.
    delete (globalThis as { localStorage?: unknown }).localStorage;
    try {
      expect(() => rememberSource('a')).not.toThrow();
      expect(() => rememberSource(null)).not.toThrow();
    } finally {
      if (original !== undefined) (globalThis as { localStorage?: unknown }).localStorage = original;
    }
  });

  test('a localStorage that throws on access is treated the same as none: null, no throw', () => {
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: blocked'); },
    });
    try {
      expect(readRememberedSource()).toBeNull();
      expect(() => rememberSource('a')).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});
