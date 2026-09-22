import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { filesApi, type FileContent, type FileSaveResult } from '../api.ts';
import { Button, Empty, Icon, Notice } from '../ui/index.tsx';
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
 * The right-hand pane, carved out of the console's old Files page component
 * (deleted at Task 10, once this file was wired into the shell at Task 8). Behaviour is moved,
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
    // Clear the previous file's state before fetching the new one. Without
    // this, a save notice, a stale-save notice, or a read error from the
    // FILE JUST LEFT stays on screen describing the file now open — a stale
    // "This file changed elsewhere" or "You are editing this Source as an
    // org admin" notice is not cosmetic, it is a false statement about the
    // file on screen, and a stale `baseline` would let `isDirty` compare the
    // new text against the old file's content. `file`/`baseline`/`draft`
    // are cleared too so the previous file's content cannot flash in the
    // editor, or be saved against the new path, while the fetch is in
    // flight.
    setFile(null);
    setBaseline('');
    setDraft('');
    setSaveResult(null);
    setSaveError(null);
    setFileError(null);
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
  //
  // Phase 1 left `{ dark: true }` hardcoded on the CodeMirror theme
  // (`editor/theme.ts`) and deferred the fix here on the grounds that fixing
  // it means remounting when the theme changes — an Editor-lifecycle concern.
  // It is NOT fixed here, and deliberately so: remounting is only half of it,
  // and it is the half that does nothing on its own. `consoleEditorTheme` is a
  // module-level constant with the flag baked in, and `mountMarkdownEditor`
  // takes no theme argument, so a theme-keyed remount today would tear down
  // the operator's caret and scroll position and rebuild a byte-identical
  // extension set. Adding the remount dep is one line once `editor/theme.ts`
  // exposes the flag and `editor/index.ts` threads it through; both are
  // outside this phase's fence, so the requirement is reported instead.
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
    //
    // `sourceId` is in this dep array even though nothing inside the effect
    // body reads it. The host div below only renders once `sourceId` is
    // non-null (see the early "No Sources you can reach." return above); on
    // a deep link, the first render or two can have `path` already set while
    // `sourceId` is still resolving, so `hostRef.current` is null and this
    // effect bails out having mounted nothing. If `sourceId` is not a dep,
    // the render that finally creates the host div is not one this effect
    // re-runs for — `path` never changed, so nothing ever mounts, and the
    // editor stays permanently blank. Do not drop this as "unused".
  }, [sourceId, path]);

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
      <div className="flex flex-col h-full min-h-0">
        <Empty>No Sources you can reach.</Empty>
      </div>
    );
  }

  if (path === null) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <Empty>Pick a file to read it.</Empty>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted font-mono">{path}</div>
        {canEdit(access) && file !== null && (
          <div className="flex items-center gap-2">
            {/* Both of these were `.nav-item`, which is a left-aligned,
                full-width nav row wearing a button's job. They are ordinary
                auto-width controls in a toolbar, so `Button` is the right
                shape for them — unlike the settings tab list, which is not. */}
            <Button onClick={() => setMode((m) => (m === 'edit' ? 'read' : 'edit'))}>
              {editToggleLabel(mode)}
            </Button>
            {mode === 'edit' && (
              <Button
                variant="primary"
                disabled={pending || !dirty || access !== 'write'}
                onClick={() => void save()}
              >
                {saveButtonLabel(pending)}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Five status messages, one shape. They used to be five bare coloured
          `<div>`s of the same 13px text, which meant the one that says a save
          did NOT land looked exactly like the one that says it did — the
          colour was the only difference, and colour alone is not a message.
          As `Notice` each carries its tone AND a glyph, and every string is
          byte-identical to what it was: the copy still comes from
          `files/tree.ts`, which is where the tests assert it. */}
      {fileError && (
        <Notice tone="danger"><Icon glyph={CircleAlert} size={16} /><span>{fileError}</span></Notice>
      )}
      {saveError && (
        <Notice tone="danger"><Icon glyph={CircleAlert} size={16} /><span>{saveError}</span></Notice>
      )}
      {saveResult !== null && saveResult.committed && (
        <Notice tone="ok"><Icon glyph={CircleCheck} size={16} /><span>{saveSuccessText(saveResult.sha)}</span></Notice>
      )}
      {bypassVisible(saveResult) && (
        <Notice tone="warning"><Icon glyph={TriangleAlert} size={16} /><span>{BYPASS_NOTICE}</span></Notice>
      )}
      {saveResult !== null && !saveResult.committed && (
        // Reload lives inside the notice that explains why it is there. A
        // stale-save warning with its remedy parked underneath it is two
        // things an operator has to connect; this is one.
        <Notice tone="warning">
          <Icon glyph={TriangleAlert} size={16} />
          <div className="flex flex-col items-start gap-2">
            <span>{staleNotice(saveResult.sha)}</span>
            <Button disabled={reloading} onClick={() => void reload()}>
              {reloading ? 'Reloading…' : 'Reload'}
            </Button>
          </div>
        </Notice>
      )}

      <div ref={hostRef} className="markdown-editor flex-1" />
    </div>
  );
}
