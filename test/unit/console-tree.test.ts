import { test, expect, describe } from 'bun:test';
import {
  buildTree, flattenTree, toggleExpanded, fileKind, baseName, pathDepth, indentFor,
  type TreeItem,
} from '../../src/console/files/tree.ts';
import type { FileEntry } from '../../src/console/api.ts';

/**
 * `files/tree.ts` turns gitTree's flat, files-only, sorted list into a real
 * nested tree the sidebar can collapse. There is no DOM harness in this repo,
 * so buildTree/flattenTree/toggleExpanded are the only place these decisions
 * are testable at all.
 */

const entry = (path: string, over: Partial<FileEntry> = {}): FileEntry => ({
  path,
  size: 0,
  isMarkdown: fileKind(path) === 'markdown',
  ...over,
});

describe('buildTree — synthesizing folders from a flat, files-only list', () => {
  // Folders read before files at a glance; within a group, code-unit order
  // (never localeCompare) keeps the tree stable across browsers and locales —
  // the same rule Files.tsx:35-38's comparePaths states.
  test('folders sort before files at each level; within a group, code-unit order', () => {
    const tree = buildTree([
      entry('roadmap.md'), entry('product/specs/auth.md'), entry('product/README.md'),
      entry('notes/README.md'),
    ]);
    expect(tree.map((n) => n.name)).toEqual(['notes', 'product', 'roadmap.md']);
  });

  // gitTree (src/ops/git.ts) walks the working tree and pushes an entry only
  // for entry.isFile() — a bare directory is never emitted, so buildTree has
  // nothing to synthesize a folder node from. An empty folder is therefore
  // invisible BY CONSTRUCTION, not a bug to "fix" with a phantom-folder row.
  test('an empty folder cannot appear: the backend walk never emits a directory entry', () => {
    const tree = buildTree([entry('a/b.md')]);
    const folder = tree.find((n) => n.kind === 'folder') as Extract<TreeItem, { kind: 'folder' }>;
    expect(folder.children).toHaveLength(1);
    expect(folder.children[0]!.kind).toBe('file');
  });

  test('nested depth is preserved through multiple folder levels', () => {
    const tree = buildTree([entry('product/specs/auth.md')]);
    const product = tree[0] as Extract<TreeItem, { kind: 'folder' }>;
    const specs = product.children[0] as Extract<TreeItem, { kind: 'folder' }>;
    expect(product.name).toBe('product');
    expect(specs.name).toBe('specs');
    expect(specs.children[0]!.name).toBe('auth.md');
  });

  // A single-segment path is a root-level file at depth 0 — no folder is
  // synthesized for it.
  test('a single-segment path is a root-level file, not a folder', () => {
    const tree = buildTree([entry('README.md')]);
    expect(tree).toEqual([{ kind: 'file', path: 'README.md', name: 'README.md', fileKind: 'markdown' }]);
  });

  test('a non-markdown file keeps its fileKind through the tree', () => {
    const tree = buildTree([entry('notes/plan.txt')]);
    const folder = tree[0] as Extract<TreeItem, { kind: 'folder' }>;
    const file = folder.children[0] as Extract<TreeItem, { kind: 'file' }>;
    expect(file.fileKind).toBe('other');
  });

  // buildTree must not rely on the backend's own sort — shuffled input must
  // produce the identical tree as sorted input.
  test('deterministic regardless of input order', () => {
    const sortedOrder = buildTree([
      entry('a.md'), entry('b/c.md'), entry('b/a.md'), entry('z.md'),
    ]);
    const shuffled = buildTree([
      entry('z.md'), entry('b/a.md'), entry('a.md'), entry('b/c.md'),
    ]);
    expect(shuffled).toEqual(sortedOrder);
  });

  // Folders carry their full path from the root, so it is a stable key into
  // the expansion Set even when two folders share a basename at different
  // levels (e.g. 'specs' vs 'product/specs').
  test('a folder\'s path is its full path from the root', () => {
    const tree = buildTree([entry('specs/x.md'), entry('product/specs/y.md')]);
    const specsTop = tree.find((n) => n.kind === 'folder' && n.name === 'specs') as Extract<TreeItem, { kind: 'folder' }>;
    const product = tree.find((n) => n.kind === 'folder' && n.name === 'product') as Extract<TreeItem, { kind: 'folder' }>;
    const specsNested = product.children[0] as Extract<TreeItem, { kind: 'folder' }>;
    expect(specsTop.path).toBe('specs');
    expect(specsNested.path).toBe('product/specs');
  });
});

describe('flattenTree — the visible rows for a given expansion state', () => {
  test('a collapsed folder hides its children', () => {
    const tree = buildTree([entry('product/specs/auth.md'), entry('roadmap.md')]);
    const rows = flattenTree(tree, new Set());
    expect(rows.map((r) => r.name)).toEqual(['product', 'roadmap.md']);
  });

  test('expanding a folder reveals its direct children only', () => {
    const tree = buildTree([entry('product/specs/auth.md'), entry('roadmap.md')]);
    const rows = flattenTree(tree, new Set(['product']));
    expect(rows.map((r) => r.name)).toEqual(['product', 'specs', 'roadmap.md']);
  });

  // Every ancestor must be expanded for a deep row to show — expanding a leaf
  // folder without expanding its parent must not surface it.
  test('a row only shows when every ancestor folder is expanded', () => {
    const tree = buildTree([entry('product/specs/auth.md')]);
    const onlyLeafExpanded = flattenTree(tree, new Set(['specs']));
    expect(onlyLeafExpanded.map((r) => r.name)).toEqual(['product']);

    const bothExpanded = flattenTree(tree, new Set(['product', 'product/specs']));
    expect(bothExpanded.map((r) => r.name)).toEqual(['product', 'specs', 'auth.md']);
  });

  // depth still comes from separator count, reused verbatim from indentFor.
  test('depth increases one level per folder nesting, matching indentFor', () => {
    const tree = buildTree([entry('product/specs/auth.md')]);
    const rows = flattenTree(tree, new Set(['product', 'product/specs']));
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.product!.depth).toBe(0);
    expect(byName.specs!.depth).toBe(1);
    expect(byName['auth.md']!.depth).toBe(2);
    expect(indentFor(byName['auth.md']!.depth)).toBe(24);
  });

  // A folder row carries its own expanded state, so the caller never has to
  // re-derive "is this open" from the Set itself.
  test('a folder row reports its own expanded state', () => {
    const tree = buildTree([entry('product/specs/auth.md')]);
    const collapsed = flattenTree(tree, new Set());
    expect(collapsed.find((r) => r.name === 'product')!.expanded).toBe(false);

    const expanded = flattenTree(tree, new Set(['product']));
    expect(expanded.find((r) => r.name === 'product')!.expanded).toBe(true);
  });

  test('an empty tree flattens to no rows', () => {
    expect(flattenTree([], new Set())).toEqual([]);
  });
});

describe('toggleExpanded', () => {
  test('toggling an unexpanded path expands it, and back again', () => {
    const first = toggleExpanded(new Set(), 'product');
    expect(first.has('product')).toBe(true);
    const second = toggleExpanded(first, 'product');
    expect(second.has('product')).toBe(false);
  });

  // Same discipline treeToNodes already follows ("the caller's data is not
  // this function's to mutate") — toggleExpanded must return a NEW Set.
  test('never mutates the input set', () => {
    const original = new Set(['product']);
    const result = toggleExpanded(original, 'notes');
    expect(original.has('notes')).toBe(false);
    expect(result).not.toBe(original);
    expect(result.has('notes')).toBe(true);
    expect(result.has('product')).toBe(true);
  });
});

describe('baseName, pathDepth, indentFor — reused verbatim by the tree', () => {
  test('baseName and pathDepth agree with buildTree\'s own notion of depth', () => {
    expect(baseName('a/b/c.md')).toBe('c.md');
    expect(pathDepth('a/b/c.md')).toBe(2);
    expect(pathDepth('c.md')).toBe(0);
  });

  test('indentation never goes negative', () => {
    expect(indentFor(0)).toBe(0);
    expect(indentFor(3)).toBe(36);
    expect(indentFor(-1)).toBe(0);
  });
});
