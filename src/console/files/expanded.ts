/**
 * Persisted folder-expansion state for the sidebar file tree, keyed per
 * Source. This lives apart from `files/tree.ts` because that module is
 * deliberately pure and DOM-free (`buildTree`/`flattenTree`/`toggleExpanded`
 * take and return plain data, no `localStorage`, no `window`) — this module
 * is the one place that talks to browser storage, so the pure tree logic
 * stays testable without a DOM harness.
 *
 * Keyed per Source because folder paths only mean something within the
 * Source they came from: `docs/specs` expanded in one Source says nothing
 * about whether a `docs/specs` folder in a different Source should also
 * start open, and two Sources may not even share that path at all.
 *
 * Every `localStorage` read and write is wrapped in try/catch: it throws in
 * a private window, with site data blocked, and in some embedded webviews. A
 * console that white-screens because a UI preference could not be read is
 * worse than a console that simply forgets which folders were open — so a
 * failed read returns an empty Set and a failed write is silently swallowed.
 * A stored value that is not a JSON array of strings is treated the same way:
 * this is a preference a user's browser could have handed back in any shape,
 * never something to trust structurally.
 */

const KEY_PREFIX = 'mobrain:console:expanded:';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function readExpanded(sourceId: string): Set<string> {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + sourceId);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return isStringArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

export function writeExpanded(sourceId: string, expanded: ReadonlySet<string>): void {
  try {
    localStorage.setItem(KEY_PREFIX + sourceId, JSON.stringify([...expanded]));
  } catch {
    // No preference kept. The tree simply remembers nothing this session.
  }
}

/**
 * Drops remembered folder paths that no longer exist, so a deleted (or
 * renamed) folder does not linger in the stored expansion set forever. Pure
 * — never mutates its arguments, always returns a new Set — which is what
 * makes it testable without a DOM.
 */
export function pruneExpanded(
  expanded: ReadonlySet<string>,
  knownFolders: ReadonlySet<string>,
): Set<string> {
  const next = new Set<string>();
  for (const path of expanded) if (knownFolders.has(path)) next.add(path);
  return next;
}
