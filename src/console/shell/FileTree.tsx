import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { filesApi, type FileEntry } from '../api.ts';
import { buildTree, flattenTree, toggleExpanded, indentFor, treeErrorMessage } from '../files/tree.ts';
import { readExpanded, writeExpanded, pruneExpanded } from '../files/expanded.ts';
import { Empty, Icon } from '../ui/index.tsx';

/**
 * The sidebar's collapsible file tree. Fetches `filesApi.tree(sourceId)`
 * whenever `sourceId` changes, using the same `cancelled` guard
 * the console's old Files page component used for its own tree effect, so a fast Source switch
 * cannot let a stale response land after a newer one already did.
 *
 * Expansion state is loaded per Source (`files/expanded.ts`), pruned against
 * the folders this load actually found (so a deleted folder does not linger
 * in storage forever), and persisted again on every toggle.
 */
export function FileTree({
  sourceId,
  selectedPath,
  onSelect,
}: {
  sourceId: string | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sourceId === null) {
      setEntries([]);
      setExpanded(new Set());
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void filesApi.tree(sourceId)
      .then((tree) => {
        if (cancelled) return;
        setEntries(tree.entries);
        const known = new Set(
          buildTree(tree.entries)
            .flatMap(function collectFolders(item): string[] {
              return item.kind === 'folder'
                ? [item.path, ...item.children.flatMap(collectFolders)]
                : [];
            }),
        );
        const pruned = pruneExpanded(readExpanded(sourceId), known);
        setExpanded(pruned);
        writeExpanded(sourceId, pruned);
      })
      .catch(() => { if (!cancelled) setError(treeErrorMessage); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sourceId]);

  const toggle = (path: string) => {
    if (sourceId === null) return;
    const next = toggleExpanded(expanded, path);
    setExpanded(next);
    writeExpanded(sourceId, next);
  };

  if (sourceId === null) return null;
  // `Empty` rather than a hand-rolled muted div, and deliberately not a
  // `Spinner`: the tree is the sidebar's whole content, and a spinner where a
  // list is about to appear draws the eye to the wait instead of to the list.
  // The copy is unchanged, which is the other half of the reason — a spinner
  // would have had to replace the word "Loading…" rather than restyle it.
  if (loading) return <div className="file-tree"><Empty>Loading…</Empty></div>;
  // Left as coloured text, not a `Notice`: a bordered panel inside a 280px
  // sidebar column is a card wedged into a list. `Notice` is reserved for the
  // standing warnings that were `.card border-warning`.
  if (error !== null) return <div className="file-tree text-danger">{error}</div>;

  const rows = flattenTree(buildTree(entries), expanded);
  if (rows.length === 0) return <div className="file-tree"><Empty>No files in this Source.</Empty></div>;

  return (
    <div className="file-tree" aria-label="Files">
      {rows.map((row) => {
        const isSelected = row.kind === 'file' && row.path === selectedPath;
        const isExpanded = row.kind === 'folder' && row.expanded === true;
        const classes = ['tree-row'];
        if (isSelected) classes.push('is-selected');
        if (isExpanded) classes.push('is-expanded');
        return (
          <button
            key={row.path}
            type="button"
            className={classes.join(' ')}
            style={{ paddingLeft: indentFor(row.depth) + 8 }}
            aria-expanded={row.kind === 'folder' ? isExpanded : undefined}
            onClick={() => (row.kind === 'folder' ? toggle(row.path) : onSelect(row.path))}
          >
            {/* The `▶` codepoint is gone, but `.chevron` stays on the node:
                `.tree-row.is-expanded .chevron` is what rotates it 90°, and
                that rule is in `styles.css`, which this phase does not own.
                `Icon` merges the class in, so the rotation still finds it. */}
            {row.kind === 'folder' && <Icon glyph={ChevronRight} size={14} className="chevron" />}
            {row.name}
          </button>
        );
      })}
    </div>
  );
}
