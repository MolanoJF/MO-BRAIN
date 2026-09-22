import { useEffect, useState } from 'react';
import { filesApi, type FileEntry } from '../api.ts';
import { buildTree, flattenTree, toggleExpanded, indentFor, treeErrorMessage } from '../files/tree.ts';
import { readExpanded, writeExpanded, pruneExpanded } from '../files/expanded.ts';

/**
 * The sidebar's collapsible file tree. Fetches `filesApi.tree(sourceId)`
 * whenever `sourceId` changes, using the same `cancelled` guard
 * `pages/Files.tsx` uses for its own tree effect, so a fast Source switch
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
  if (loading) return <div className="file-tree text-muted">Loading…</div>;
  if (error !== null) return <div className="file-tree text-danger">{error}</div>;

  const rows = flattenTree(buildTree(entries), expanded);
  if (rows.length === 0) return <div className="file-tree text-muted">No files in this Source.</div>;

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
            {row.kind === 'folder' && <span className="chevron">▶</span>}
            {row.name}
          </button>
        );
      })}
    </div>
  );
}
