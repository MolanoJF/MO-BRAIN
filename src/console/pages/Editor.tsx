import { useEffect, useRef, useState } from 'react';
import { filesApi, type FileContent, type FileSaveResult } from '../api.ts';
import {
  mountMarkdownEditor,
  type EditorMode,
  type MarkdownEditorHandle,
} from '../editor/index.ts';
import {
  canEdit, editToggleLabel, saveButtonLabel, saveSuccessText, saveFailureText,
  staleNotice, bypassVisible, isDirty, modeAfterSave, BYPASS_NOTICE, errorText,
  fileErrorMessage,
} from '../files/tree.ts';

/* -------------------------------------------------------------------------
 * The right-hand pane, carved out of pages/Files.tsx (Task 10 deletes that
 * file once this one is wired into the shell at Task 8). Behaviour is moved,
 * not changed: every save rule, error channel and piece of copy comes across
 * byte-identical. This component is fully controlled — it does not pick the
 * Source, does not list the tree, and does not own the selection; it owns
 * only what happens to the open file: fetching it, editing it, saving it,
 * reloading it.
 * ---------------------------------------------------------------------- */

export function Editor(props: {
  sourceId: string | null;
  path: string | null;
  access: 'read' | 'write' | null;
}) {
  const { sourceId, path, access } = props;

  const [file, setFile] = useState<FileContent | null>(null);
  const [mode, setMode] = useState<EditorMode>('read');
  const [baseline, setBaseline] = useState('');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [saveResult, setSaveResult] = useState<FileSaveResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MarkdownEditorHandle | null>(null);

  useEffect(() => {
    if (sourceId === null || path === null) return;
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

  const dirty = isDirty(baseline, draft);

  const save = async () => {
    if (sourceId === null || path === null || file === null || pending) return;
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
    if (sourceId === null || path === null || reloading) return;
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

  if (sourceId === null) {
    return (
      <div className="main flex flex-col">
        <p className="text-sm text-muted">No Sources you can reach.</p>
      </div>
    );
  }

  if (path === null) {
    return (
      <div className="main flex flex-col">
        <p className="text-sm text-muted">Pick a file to read it.</p>
      </div>
    );
  }

  return (
    <div className="main flex flex-col space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted font-mono">{path}</div>
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
      </div>

      {fileError && <div className="text-danger text-sm">{fileError}</div>}
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

      <div ref={hostRef} className="markdown-editor flex-1" />
    </div>
  );
}
