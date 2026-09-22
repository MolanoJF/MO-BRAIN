import { useEffect, useRef, useState } from 'react';
import {
  filesApi,
  type FileContent, type FileEntry, type FileSaveResult, type SpaceSummary,
} from '../api.ts';
import {
  mountMarkdownEditor,
  type EditorMode,
  type MarkdownEditorHandle,
} from '../editor/index.ts';

/* -------------------------------------------------------------------------
 * These helpers moved to files/tree.ts (Task 3) — same names, same bodies,
 * same doc comments, unchanged. Re-exported here so this file keeps
 * compiling and so test/unit/console-files.test.ts, which still imports them
 * from this module, keeps passing untouched. Files.tsx itself is deleted at
 * Task 10, once pages/Editor.tsx exists to take over its render; this
 * re-export is a bridge until then.
 * ---------------------------------------------------------------------- */
export {
  fileKind, baseName, pathDepth, indentFor, spacePickerLabel, accessNotice,
  BYPASS_NOTICE, emptyStateText, treeErrorMessage, fileErrorMessage, errorText,
  canEdit, editToggleLabel, saveButtonLabel, saveSuccessText, saveFailureText,
  staleNotice, bypassVisible, isDirty, modeAfterSave,
  type FileKind,
} from '../files/tree.ts';
import {
  fileKind, baseName, pathDepth, indentFor, accessNotice,
  BYPASS_NOTICE, emptyStateText, treeErrorMessage, fileErrorMessage, errorText,
  canEdit, editToggleLabel, saveButtonLabel, saveSuccessText, saveFailureText,
  staleNotice, bypassVisible, isDirty, modeAfterSave, spacePickerLabel,
  type FileKind,
} from '../files/tree.ts';

/** One row of the file tree, as the page renders it: no path arithmetic in JSX. */
export type TreeNode = {
  path: string;
  name: string;
  depth: number;
  kind: FileKind;
};

/** Code-unit order, so the tree is stable across browsers and locales. */
function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The flat entry list as a deterministic, renderable tree. Sorted by path so a
 * refresh cannot reshuffle it, depth derived from the separators, name from the
 * basename. The input array is copied, never sorted in place: the caller's data
 * is not this function's to mutate.
 */
export function treeToNodes(entries: FileEntry[]): TreeNode[] {
  return [...entries]
    .sort((a, b) => comparePaths(a.path, b.path))
    .map((entry) => ({
      path: entry.path,
      name: baseName(entry.path),
      depth: pathDepth(entry.path),
      kind: fileKind(entry.path),
    }));
}

/* -------------------------------------------------------------------------
 * The page. Reading is Stage 1's behaviour unchanged; writing is the Edit
 * toggle (only on a `write` Connection), a Save whose stale answer is a choice,
 * and an inline bypass disclosure on a committed save.
 * ---------------------------------------------------------------------- */

export function Files() {
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [mode, setMode] = useState<EditorMode>('read');
  const [baseline, setBaseline] = useState('');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [saveResult, setSaveResult] = useState<FileSaveResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MarkdownEditorHandle | null>(null);

  useEffect(() => {
    void filesApi.list()
      .then((body) => {
        setSpaces(body.spaces);
        setSourceId((current) => current || (body.spaces[0]?.sourceId ?? ''));
        setError(null);
      })
      .catch((e) => setError(errorText(e, 'The Source list could not be loaded.')));
  }, []);

  useEffect(() => {
    if (sourceId === '') return;
    setEntries([]);
    setPath(null);
    setFile(null);
    setBaseline('');
    setDraft('');
    setSaveResult(null);
    setSaveError(null);
    setTreeError(null);
    setFileError(null);
    setLoading(true);
    let cancelled = false;
    void filesApi.tree(sourceId)
      .then((tree) => { if (!cancelled) setEntries(tree.entries); })
      .catch((e) => { if (!cancelled) setTreeError(errorText(e, treeErrorMessage)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sourceId]);

  useEffect(() => {
    if (sourceId === '' || path === null) return;
    let cancelled = false;
    void filesApi.file(sourceId, path)
      .then((body) => {
        if (cancelled) return;
        setFile(body);
        // The loaded text is the baseline a save compares against and the
        // expectedSha it sends.
        setBaseline(body.content);
        setDraft(body.content);
      })
      .catch((e) => { if (!cancelled) setFileError(errorText(e, fileErrorMessage)); });
    return () => { cancelled = true; };
  }, [sourceId, path]);

  // Stage 1 is read-only; a new file opens in read mode. Stage 2's Edit toggle
  // flips this state and adds a Save button.
  useEffect(() => { setMode('read'); }, [path]);

  // Mount once per selected file, and reuse the live handle for later value
  // pushes. `destroy()` is idempotent, so StrictMode's double-mount is safe:
  // the first handle is destroyed and the ref cleared before the second mount
  // creates its own.
  useEffect(() => {
    const parent = hostRef.current;
    if (path === null || parent === null) return;
    const handle = mountMarkdownEditor({
      parent,
      doc: file?.content ?? '',
      mode,
      // Programmatic `setValue` never fires this, so loading a file does not
      // count as an edit — only the operator's typing does.
      onChange: (value) => setDraft(value),
    });
    editorRef.current = handle;
    return () => {
      handle.destroy();
      if (editorRef.current === handle) editorRef.current = null;
    };
    // The value/mode effect below owns updates; this effect owns lifetime.
  }, [path]);

  useEffect(() => {
    const handle = editorRef.current;
    if (handle === null) return;
    if (file !== null) handle.setValue(file.content);
    handle.setMode(mode);
  }, [file, mode]);

  const selected = spaces.find((s) => s.sourceId === sourceId) ?? null;
  const nodes = treeToNodes(entries);
  const access = selected?.access ?? null;

  const dirty = isDirty(baseline, draft);

  const pickFile = (next: string) => {
    // Clear synchronously so the remount never flashes the previous file while
    // the new one is still in flight, and so a stale draft can never be saved
    // against the newly selected path.
    setPath(next);
    setFile(null);
    setFileError(null);
    setBaseline('');
    setDraft('');
    setSaveResult(null);
    setSaveError(null);
  };

  const save = async () => {
    if (sourceId === '' || path === null || file === null || pending) return;
    const content = editorRef.current?.getValue() ?? draft;
    setPending(true);
    setSaveError(null);
    setSaveResult(null);
    try {
      const result = await filesApi.save(sourceId, path, { content, expectedSha: file.sha });
      setSaveResult(result);
      if (result.committed) {
        // The committed content becomes the new baseline and its sha the next
        // expectedSha, so a second save is not a second stale.
        setFile((f) => (f === null ? f : { ...f, content, sha: result.sha }));
        setBaseline(content);
        setDraft(content);
        setMode(modeAfterSave());
      }
      // A stale result wrote nothing: the notice above the Reload button says
      // so, and the held file is left untouched until the operator reloads.
    } catch (e) {
      setSaveError(saveFailureText(errorText(e, 'the server did not say why.')));
    } finally {
      setPending(false);
    }
  };

  const reload = async () => {
    if (sourceId === '' || path === null || reloading) return;
    setReloading(true);
    setSaveError(null);
    try {
      const body = await filesApi.file(sourceId, path);
      setFile(body);
      setBaseline(body.content);
      setDraft(body.content);
      setSaveResult(null);
    } catch (e) {
      setSaveError(errorText(e, fileErrorMessage));
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className="max-w-5xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Files</h1>
        <p className="text-sm text-muted">
          Browse the markdown in every Source you can reach, and edit the ones you can write to.
        </p>
      </header>

      {error && <div className="text-danger text-sm">{error}</div>}

      <section className="space-y-2">
        <label className="text-sm block">Source
          <select
            className="field mt-1"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            disabled={spaces.length === 0}
          >
            {spaces.length === 0 && <option value="">{emptyStateText}</option>}
            {spaces.map((space) => (
              <option key={space.id} value={space.sourceId}>{spacePickerLabel(space)}</option>
            ))}
          </select>
        </label>
        <p className="text-sm text-muted">
          {spaces.length === 0 ? emptyStateText : accessNotice(access)}
        </p>
      </section>

      <div className="flex gap-6">
        <aside className="w-64 shrink-0 space-y-1">
          <h2 className="font-medium">Files</h2>
          {treeError && <div className="text-danger text-sm">{treeError}</div>}
          {loading && <p className="text-sm text-muted">Loading…</p>}
          {!loading && !treeError && nodes.length === 0 && (
            <p className="text-sm text-muted">No files in this Source.</p>
          )}
          {nodes.map((node) => (
            <button
              key={node.path}
              className={`nav-item font-mono text-xs ${path === node.path ? 'text-ok' : ''}`}
              style={{ paddingLeft: indentFor(node.depth) + 8 }}
              onClick={() => pickFile(node.path)}
            >
              {node.name}
              {node.kind === 'markdown' ? '' : <span className="text-muted"> · other</span>}
            </button>
          ))}
        </aside>

        <section className="min-w-0 flex-1 space-y-2">
          {path === null ? (
            <p className="text-sm text-muted">Pick a file to read it.</p>
          ) : (
            <>
              <div className="text-xs text-muted font-mono">{path}</div>
              {fileError && <div className="text-danger text-sm">{fileError}</div>}

              {canEdit(access) && file !== null && (
                <div className="flex items-center gap-2">
                  <button
                    className="nav-item"
                    onClick={() => setMode((m) => (m === 'edit' ? 'read' : 'edit'))}
                  >
                    {editToggleLabel(mode)}
                  </button>
                  {mode === 'edit' && (
                    <button
                      className="btn-primary"
                      disabled={pending || !dirty || access !== 'write'}
                      onClick={() => void save()}
                    >
                      {saveButtonLabel(pending)}
                    </button>
                  )}
                </div>
              )}

              {saveError && <div className="text-danger text-sm">{saveError}</div>}
              {saveResult !== null && saveResult.committed && (
                <div className="text-sm text-ok">{saveSuccessText(saveResult.sha)}</div>
              )}
              {bypassVisible(saveResult) && (
                <div className="text-sm text-warning">{BYPASS_NOTICE}</div>
              )}
              {saveResult !== null && !saveResult.committed && (
                <div className="space-y-1">
                  <div className="text-sm text-warning">{staleNotice(saveResult.sha)}</div>
                  <button className="nav-item" disabled={reloading} onClick={() => void reload()}>
                    {reloading ? 'Reloading…' : 'Reload'}
                  </button>
                </div>
              )}

              <div ref={hostRef} className="markdown-editor" style={{ height: '70vh' }} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
