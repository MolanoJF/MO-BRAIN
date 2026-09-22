import { useEffect, useRef, useState } from 'react';
import {
  ApiError, filesApi,
  type FileContent, type FileEntry, type FileSaveResult, type SpaceSummary,
} from '../api.ts';
import {
  mountMarkdownEditor,
  type EditorMode,
  type MarkdownEditorHandle,
} from '../editor/index.ts';

/* -------------------------------------------------------------------------
 * Pure helpers. Exported so test/unit/console-files.test.ts can assert the
 * decisions and the copy without a DOM server — the access notice and the
 * admin-bypass disclosure are strings the operator reads, so they are testable
 * state, not decoration.
 * ---------------------------------------------------------------------- */

export type FileKind = 'markdown' | 'other';

/** `.md` / `.markdown`, case-insensitive. Everything else is `other`. */
export function fileKind(path: string): FileKind {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown') ? 'markdown' : 'other';
}

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

/** The last segment of a `/`-separated path — never the whole path. */
export function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/** Directory depth: the number of `/` separators, so a top-level file is 0. */
export function pathDepth(path: string): number {
  return path.split('/').length - 1;
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

/** The picker label: the Space's name, with its source id as the disambiguator. */
export function spacePickerLabel(space: SpaceSummary): string {
  return `${space.name} (${space.sourceId})`;
}

/**
 * What this operator may do in the selected Space, in plain words. `null` is
 * "nothing is selected yet", which is not the same as "no access".
 */
export function accessNotice(access: 'read' | 'write' | null): string {
  if (access === 'write') return 'You can edit this Space.';
  if (access === 'read') return 'Read-only: you can browse this Space but not change it.';
  return 'No access to this Space.';
}

/**
 * Stage 2 copy: the inline notice shown when an org admin opens a Space they
 * have no write Connection to. Defined now so the unit test locks the wording;
 * the Edit toggle that renders it lands with the PUT route.
 */
export const BYPASS_NOTICE =
  'You are editing this Space as an org admin outside your Connections.';

export const emptyStateText = 'No Spaces are visible to your account.';

export const treeErrorMessage = 'This Space could not be listed.';

export const fileErrorMessage = 'This file could not be read.';

/** The server's own words for a failed request, never a raw object. */
export function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message !== '') return e.message;
  return fallback;
}

/** Indentation for a tree row: one step per directory level. */
export function indentFor(depth: number): number {
  return Math.max(0, depth) * 12;
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
      .catch((e) => setError(errorText(e, 'The Space list could not be loaded.')));
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
          Browse the markdown in every Space you can reach, and edit the ones you can write to.
        </p>
      </header>

      {error && <div className="text-danger text-sm">{error}</div>}

      <section className="space-y-2">
        <label className="text-sm block">Space
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
        {sourceId !== '' && (
          <a
            className="nav-item inline-block text-sm"
            href={filesApi.exportUrl(sourceId)}
            download
          >
            Export as .bundle
          </a>
        )}
      </section>

      <div className="flex gap-6">
        <aside className="w-64 shrink-0 space-y-1">
          <h2 className="font-medium">Files</h2>
          {treeError && <div className="text-danger text-sm">{treeError}</div>}
          {loading && <p className="text-sm text-muted">Loading…</p>}
          {!loading && !treeError && nodes.length === 0 && (
            <p className="text-sm text-muted">No files in this Space.</p>
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
