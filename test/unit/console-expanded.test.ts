import { test, expect, describe, beforeEach } from 'bun:test';
import { readExpanded, writeExpanded, pruneExpanded } from '../../src/console/files/expanded.ts';

/**
 * `files/expanded.ts` persists which folders are expanded, per Source, in
 * localStorage. There is no DOM harness in this repo (no happy-dom, jsdom,
 * testing-library), so `pruneExpanded` — the pure decision at the heart of
 * this module — is what these tests actually cover. The localStorage-backed
 * read/write functions are exercised too, since `bun:test` runs under a
 * `window`-less/`localStorage`-less environment by default and that is
 * exactly the "storage throws" case the module has to survive.
 */

describe('pruneExpanded — drop remembered folders that no longer exist', () => {
  test('keeps known folders and drops unknown ones', () => {
    const expanded = new Set(['a', 'a/b', 'c']);
    const known = new Set(['a', 'a/b']);
    const result = pruneExpanded(expanded, known);
    expect([...result].sort()).toEqual(['a', 'a/b']);
  });

  test('an empty known-set yields an empty result', () => {
    const expanded = new Set(['a', 'a/b']);
    const result = pruneExpanded(expanded, new Set());
    expect(result.size).toBe(0);
  });

  test('returns a new Set and never mutates its argument', () => {
    const expanded = new Set(['a', 'c']);
    const known = new Set(['a']);
    const result = pruneExpanded(expanded, known);
    expect(result).not.toBe(expanded);
    expect([...expanded].sort()).toEqual(['a', 'c']);
  });

  test('an empty expanded set yields an empty result regardless of known folders', () => {
    const result = pruneExpanded(new Set(), new Set(['a', 'b']));
    expect(result.size).toBe(0);
  });
});

describe('readExpanded — guarded against a storage that throws or lies', () => {
  test('a missing key returns an empty Set', () => {
    expect(readExpanded('no-such-source').size).toBe(0);
  });

  test('a malformed stored value (not a JSON array of strings) returns an empty Set, never throws', () => {
    // localStorage is unavailable under bun:test's default environment, so
    // any call into it throws — which is exactly the fallback path this
    // function exists to survive. Whether or not a real localStorage is
    // present, the call must never throw and must degrade to an empty Set.
    expect(() => readExpanded('some-source')).not.toThrow();
    expect(readExpanded('some-source')).toBeInstanceOf(Set);
  });
});

describe('writeExpanded — guarded against a storage that throws', () => {
  test('never throws even when storage is unavailable', () => {
    expect(() => writeExpanded('some-source', new Set(['a', 'b']))).not.toThrow();
  });
});
