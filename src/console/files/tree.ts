import { ApiError, type FileEntry, type SpaceSummary, type FileSaveResult } from '../api.ts';
import type { EditorMode } from '../editor/index.ts';

/* -------------------------------------------------------------------------
 * Pure helpers, moved verbatim from pages/Files.tsx (Task 3). Exported so
 * test/unit/console-files.test.ts and test/unit/console-tree.test.ts can
 * assert the decisions and the copy without a DOM server — the access notice
 * and the admin-bypass disclosure are strings the operator reads, so they are
 * testable state, not decoration.
 * ---------------------------------------------------------------------- */

export type FileKind = 'markdown' | 'other';

/** `.md` / `.markdown`, case-insensitive. Everything else is `other`. */
export function fileKind(path: string): FileKind {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown') ? 'markdown' : 'other';
}

/** Code-unit order, so the tree is stable across browsers and locales. */
function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The last segment of a `/`-separated path — never the whole path. */
export function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/** Directory depth: the number of `/` separators, so a top-level file is 0. */
export function pathDepth(path: string): number {
  return path.split('/').length - 1;
}

/** Indentation for a tree row: one step per directory level. */
export function indentFor(depth: number): number {
  return Math.max(0, depth) * 12;
}

/** The picker label: the Source's name, with its source id as the disambiguator. */
export function spacePickerLabel(space: SpaceSummary): string {
  return `${space.name} (${space.sourceId})`;
}

/**
 * What this operator may do in the selected Source, in plain words. `null` is
 * "nothing is selected yet", which is not the same as "no access".
 */
export function accessNotice(access: 'read' | 'write' | null): string {
  if (access === 'write') return 'You can edit this Source.';
  if (access === 'read') return 'Read-only: you can browse this Source but not change it.';
  return 'No access to this Source.';
}

/**
 * Stage 2 copy: the inline notice shown when an org admin opens a Source they
 * have no write Connection to. Defined now so the unit test locks the wording;
 * the Edit toggle that renders it lands with the PUT route.
 */
export const BYPASS_NOTICE =
  'You are editing this Source as an org admin outside your Connections.';

export const emptyStateText = 'No Sources are visible to your account.';

export const treeErrorMessage = 'This Source could not be listed.';

export const fileErrorMessage = 'This file could not be read.';

/** The server's own words for a failed request, never a raw object. */
export function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message !== '') return e.message;
  return fallback;
}

/* -------------------------------------------------------------------------
 * Stage 2 — the save decisions and the copy an operator reads. `canEdit` gates
 * the Edit toggle, `isDirty` gates the Save button, and every status sentence
 * is a named function so the unit test locks the wording without a DOM. The
 * stale result is a CHOICE, not an error, and its sentence has to say so.
 * ---------------------------------------------------------------------- */

/** Only a `write` Connection may open the editor. `null` (nothing selected yet)
 *  is not write either, and is not the same as read. */
export function canEdit(access: 'read' | 'write' | null): boolean {
  return access === 'write';
}

/** The toggle's own words, one per mode: entering is a verb, leaving is "done". */
export function editToggleLabel(mode: EditorMode): string {
  return mode === 'edit' ? 'Done editing' : 'Edit';
}

/** Two edges of one boolean, and they must never read the same. */
export function saveButtonLabel(pending: boolean): string {
  return pending ? 'Saving…' : 'Save';
}

/** The saved content named by its commit — the FULL sha, so a copy-paste into
 *  git resolves rather than guessing the prefix. */
export function saveSuccessText(sha: string): string {
  return `Saved as commit ${sha}.`;
}

/** A failed request wrapped as a sentence; the caller has already run the
 *  server's words through `errorText`, so this never carries a raw object. */
export function saveFailureText(error: string): string {
  return `The file could not be saved: ${error}`;
}

/**
 * The stale result, in plain words: the file changed on disk since it was
 * loaded, so this save wrote NOTHING and the operator must choose. It names the
 * current on-disk version when the route supplied one, and states the way
 * forward (reload, then reapply) rather than silently overwriting.
 */
export function staleNotice(sha: string | null): string {
  const current = sha === null ? '' : ` The version on disk is ${sha}.`;
  return 'This file changed elsewhere since you opened it. That save wrote nothing.'
    + `${current} Reload to see the current version, then reapply your edit.`;
}

/** Bypass is disclosed only on a COMMITTED save: a stale result wrote nothing,
 *  so it cannot have edited outside the operator's Connections. */
export function bypassVisible(result: FileSaveResult | null): boolean {
  return result !== null && result.committed && result.bypass;
}

/** A save is only useful when the editor differs from the loaded/saved text. */
export function isDirty(baseline: string, current: string): boolean {
  return baseline !== current;
}

/** A committed save returns the editor to read mode: the write is done and the
 *  status line above says so. Locked here so the page cannot drift from it. */
export function modeAfterSave(): EditorMode {
  return 'read';
}

/* -------------------------------------------------------------------------
 * The collapsible folder tree. `gitTree` (src/ops/git.ts) walks the working
 * tree and pushes an entry only for `entry.isFile()`, skipping `.git` — there
 * is no directory entry, ever. `buildTree` synthesizes the folder hierarchy
 * client-side from the `/`-separated path segments.
 * ---------------------------------------------------------------------- */

export type TreeItem =
  | { kind: 'folder'; path: string; name: string; children: TreeItem[] }
  | { kind: 'file'; path: string; name: string; fileKind: FileKind };

export type TreeRow = {
  kind: 'folder' | 'file';
  path: string;
  name: string;
  depth: number;
  expanded?: boolean;
  fileKind?: FileKind;
};

/**
 * `entries` is files only, sorted or not — the backend sorts them, but this
 * function must not depend on that (its own sort below is what makes the
 * output deterministic regardless of input order). A folder's `path` is its
 * full path from the root (`product/specs`), so it is a stable key into an
 * expansion Set even when two folders share a basename at different levels.
 *
 * Because the backend walk never emits a directory entry, a folder with zero
 * files beneath it is never synthesized — an empty folder is invisible BY
 * CONSTRUCTION. That is upstream behaviour, not a bug in this layer: do not
 * "fix" it with a phantom-folder placeholder.
 */
export function buildTree(entries: FileEntry[]): TreeItem[] {
  const root: TreeItem[] = [];
  const folders = new Map<string, Extract<TreeItem, { kind: 'folder' }>>();

  for (const entry of entries) {
    const segments = entry.path.split('/');
    let siblings = root;
    let prefix = '';
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = prefix === '' ? segments[i]! : `${prefix}/${segments[i]}`;
      let folder = folders.get(prefix);
      if (!folder) {
        folder = { kind: 'folder', path: prefix, name: segments[i]!, children: [] };
        folders.set(prefix, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    }
    siblings.push({
      kind: 'file',
      path: entry.path,
      name: baseName(entry.path),
      fileKind: fileKind(entry.path),
    });
  }
  return sortTree(root);
}

/** Folders before files at each level; within a group, code-unit order —
 *  never localeCompare (Files.tsx's own comparePaths rule, kept here so the
 *  tree is stable across browsers and locales). Applied recursively so every
 *  level is sorted, not just the root. */
function sortTree(items: TreeItem[]): TreeItem[] {
  const sorted = [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return comparePaths(a.path, b.path);
  });
  for (const item of sorted) if (item.kind === 'folder') item.children = sortTree(item.children);
  return sorted;
}

/**
 * The rows a sidebar actually paints, given which folders are open. A row
 * only appears when every one of its ancestor folders is in `expanded` — a
 * folder row carries its own `expanded` flag so the caller never has to
 * re-derive "is this open" from the Set itself.
 */
export function flattenTree(items: TreeItem[], expanded: ReadonlySet<string>, depth = 0): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const item of items) {
    if (item.kind === 'folder') {
      const isOpen = expanded.has(item.path);
      rows.push({ kind: 'folder', path: item.path, name: item.name, depth, expanded: isOpen });
      if (isOpen) rows.push(...flattenTree(item.children, expanded, depth + 1));
    } else {
      rows.push({ kind: 'file', path: item.path, name: item.name, depth, fileKind: item.fileKind });
    }
  }
  return rows;
}

/** Never mutates its input — callers hold the previous Set in React state,
 *  the same discipline treeToNodes already follows: the caller's data is not
 *  this function's to mutate. */
export function toggleExpanded(expanded: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(path)) next.delete(path); else next.add(path);
  return next;
}
