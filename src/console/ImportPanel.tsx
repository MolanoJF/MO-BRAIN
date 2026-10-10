import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { ApiError, sourcesApi, type ImportNotesBody, type ImportNotesResult } from './api.ts';
import { Button, Icon, Input, Notice } from './ui/index.tsx';
import { IMPORT_MAX_FILE_BYTES, normalizeImportPath } from '../contracts/importPlan.ts';

/**
 * Import notes into ONE Space: a git repo or a folder from this computer. A
 * preview always comes first (the server plans the import and writes
 * nothing), so the person sees how many pages land, what is skipped and what
 * gets redacted before a commit exists. Decisions live in the pure helpers
 * below; this repo has no DOM test harness.
 */

export type ImportMode = 'git' | 'folder';

export const IMPORT_NOTICE =
  'Only Markdown files are imported. Hidden folders (.git, .obsidian) are skipped, and anything that looks '
  + 'like an API key, token or private key is replaced with [REDACTED] before it is stored.';

const REASON_TEXT: Record<string, string> = {
  hidden: 'hidden',
  not_markdown: 'not Markdown',
  too_large: 'over 1 MB',
  binary: 'binary',
  invalid_path: 'unusable path',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "50 skipped: 48 hidden, 2 not Markdown", or null when nothing was. */
export function skipSummary(skipped: readonly { reason: string }[]): string | null {
  if (skipped.length === 0) return null;
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${n} ${REASON_TEXT[r] ?? r}`);
  return `${skipped.length} skipped: ${parts.join(', ')}`;
}

/** "61 secrets redacted in 61 files (anthropic-key)", or null. */
export function redactionSummary(redactions: readonly { path: string; kind: string; count: number }[]): string | null {
  if (redactions.length === 0) return null;
  const total = redactions.reduce((n, r) => n + r.count, 0);
  const files = new Set(redactions.map((r) => r.path)).size;
  const kinds = [...new Set(redactions.map((r) => r.kind))].sort().join(', ');
  return `${plural(total, 'secret')} redacted in ${plural(files, 'file')} (${kinds})`;
}

/** "5 pairs of files share a page name; only one of each becomes a page (e.g. a.md and A.md)", or null. */
export function collisionSummary(collisions: readonly string[][]): string | null {
  if (collisions.length === 0) return null;
  const [first] = collisions;
  const groups = collisions.every((g) => g.length === 2) ? plural(collisions.length, 'pair') : plural(collisions.length, 'group');
  return `${groups} of files share a page name, so only one of each becomes a page (e.g. ${first!.join(' and ')}). All are kept in git.`;
}

/** The preview's headline. */
export function previewText(r: ImportNotesResult): string {
  const changes = [
    r.added ? `${r.added} new` : null,
    r.updated ? `${r.updated} updated` : null,
    r.unchanged ? `${r.unchanged} already here` : null,
  ].filter(Boolean).join(', ');
  const cost = r.estUsd === null ? '' : ` Embedding them costs about $${r.estUsd < 0.01 ? '0.01 or less' : r.estUsd.toFixed(2)}.`;
  return `${plural(r.plan.kept, 'page')} from ${r.from}${changes ? ` (${changes})` : ''}.${cost}`;
}

/** What the person reads after the import ran. Never claims an index that did not move. */
export function doneText(r: ImportNotesResult): { tone: 'ok' | 'warning'; text: string } {
  if (r.sha === null) return { tone: 'ok', text: `Nothing to import: every page from ${r.from} is already here.` };
  const s = r.sourceStatus;
  const brain = s ? ` The brain now holds ${plural(s.pages, 'page')}, ${s.coveragePct}% embedded.` : '';
  const head = `Imported ${plural(r.added + r.updated, 'page')} from ${r.from} (commit ${r.sha.slice(0, 7)}).${brain}`;
  if (r.index?.sync?.classification !== 'ok') {
    return { tone: 'warning', text: `${head} The brain has not read the commit yet (sync exit ${r.index?.sync?.exitCode ?? '?'}). The next "Keep the brain current" run picks it up.` };
  }
  if (r.index?.embed?.classification !== 'ok') {
    return { tone: 'warning', text: `${head} Embedding stopped early (exit ${r.index?.embed?.exitCode ?? '?'}), so search may miss some pages until the next "Keep the brain current" run.` };
  }
  return { tone: 'ok', text: head };
}

export function gitUrlError(url: string): string | null {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return 'Enter the repository URL, e.g. https://github.com/you/notes.git.'; }
  if (u.protocol !== 'https:') return 'The repository URL must start with https://.';
  if (u.username !== '' || u.password !== '') return 'Leave credentials out of the URL. A private GitHub repo uses your stored token.';
  if (u.pathname.replace(/\//g, '') === '') return 'The URL must name a repository.';
  return null;
}

export function prefixError(prefix: string): string | null {
  if (prefix.trim() === '') return null;
  return normalizeImportPath('x.md', prefix.trim()) === null ? 'The folder must be a plain path like notes/vault.' : null;
}

/**
 * `webkitRelativePath` starts with the chosen folder's own name; the import
 * lands its CONTENTS, so that first segment is dropped and becomes the label.
 */
export function stripTopFolder(relative: string): { top: string; path: string } {
  const [top = '', ...rest] = relative.split('/');
  return rest.length === 0 ? { top: '', path: top } : { top, path: rest.join('/') };
}

const MARKDOWN = /\.(md|markdown)$/i;

/** Read what the server would keep anyway; everything else never leaves the page. */
async function readFolder(list: FileList): Promise<{ label: string; files: { path: string; content: string }[]; localSkips: number }> {
  const files: { path: string; content: string }[] = [];
  let label = '';
  let localSkips = 0;
  for (const f of Array.from(list)) {
    const { top, path } = stripTopFolder((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
    label ||= top;
    if (!MARKDOWN.test(path) || f.size > IMPORT_MAX_FILE_BYTES || path.split('/').some((s) => s.startsWith('.'))) {
      localSkips++;
      continue;
    }
    files.push({ path, content: await f.text() });
  }
  return { label, files, localSkips };
}

function reason(e: unknown): string {
  if (e instanceof ApiError || e instanceof Error) return e.message || 'Request failed';
  return 'Request failed';
}

export function ImportPanel({ sourceId, busy, onImported, defaultOpen = false }: {
  sourceId: string;
  busy: boolean;
  onImported: () => Promise<void> | void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [mode, setMode] = useState<ImportMode>('git');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [prefix, setPrefix] = useState('');
  const [folder, setFolder] = useState<{ label: string; files: { path: string; content: string }[]; localSkips: number } | null>(null);
  const [preview, setPreview] = useState<ImportNotesResult | null>(null);
  const [done, setDone] = useState<ImportNotesResult | null>(null);
  const [working, setWorking] = useState<'preview' | 'import' | 'read' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const body = (dryRun: boolean): ImportNotesBody | null => {
    const where = prefix.trim() ? { prefix: prefix.trim() } : {};
    if (mode === 'git') return { kind: 'git', url: url.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}), ...where, dryRun };
    if (!folder) return null;
    return { kind: 'files', files: folder.files, label: folder.label, ...where, dryRun };
  };

  const inputError = mode === 'git'
    ? gitUrlError(url) ?? prefixError(prefix)
    : (folder === null ? 'Choose a folder.' : folder.files.length === 0 ? 'That folder has no Markdown files.' : prefixError(prefix));

  const reset = () => { setPreview(null); setDone(null); setProblem(null); };

  const run = async (kind: 'preview' | 'import') => {
    const b = body(kind === 'preview');
    if (!b) return;
    setWorking(kind); setProblem(null);
    try {
      const r = await sourcesApi.importNotes(sourceId, b);
      if (kind === 'preview') { setPreview(r); setDone(null); } else { setDone(r); setPreview(null); await onImported(); }
    } catch (e) {
      setProblem(reason(e));
    } finally {
      setWorking(null);
    }
  };

  const pick = async (list: FileList | null) => {
    reset();
    if (!list || list.length === 0) { setFolder(null); return; }
    setWorking('read');
    try { setFolder(await readFolder(list)); } catch (e) { setProblem(reason(e)); } finally { setWorking(null); }
  };

  const off = busy || working !== null;
  const skips = preview ? skipSummary(preview.plan.skipped) : null;
  const localSkips = mode === 'folder' && folder && folder.localSkips > 0
    ? `${plural(folder.localSkips, 'file')} that ${folder.localSkips === 1 ? 'is' : 'are'} not Markdown stayed on this computer.` : null;
  const redacted = preview ? redactionSummary(preview.plan.redactions) : null;
  const collided = preview ? collisionSummary(preview.plan.collisions ?? []) : null;
  const finished = done ? doneText(done) : null;

  return (
    <div className="space-y-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
              className="flex w-full items-center gap-2 text-left text-[length:var(--control-font)]">
        <Icon glyph={ChevronRight} size={14} className={open ? 'rotate-90 text-muted' : 'text-muted'} />
        <span className="font-medium">Import notes</span>
        <span className="truncate text-muted">From a git repo or a folder</span>
      </button>
      {open && (
        <>
          <div className="flex gap-2">
            <Button variant={mode === 'git' ? 'primary' : undefined} disabled={off}
                    onClick={() => { setMode('git'); reset(); }}>From a git repo</Button>
            <Button variant={mode === 'folder' ? 'primary' : undefined} disabled={off}
                    onClick={() => { setMode('folder'); reset(); }}>Upload a folder</Button>
          </div>

          {mode === 'git' ? (
            <div className="flex flex-wrap gap-2">
              <Input className="min-w-0 flex-1" placeholder="https://github.com/you/notes.git" value={url}
                     onChange={(e) => { setUrl(e.target.value); reset(); }} />
              <Input className="w-32" placeholder="Branch (optional)" value={ref}
                     onChange={(e) => { setRef(e.target.value); reset(); }} />
            </div>
          ) : (
            <input type="file" multiple disabled={off} className="text-[length:var(--control-font)]"
                   {...{ webkitdirectory: '', directory: '' }}
                   onChange={(e) => void pick(e.currentTarget.files)} />
          )}
          {mode === 'git' && <p className="text-xs text-muted">A private GitHub repo uses your stored GitHub token (Settings → Credentials).</p>}
          {mode === 'folder' && folder && (
            <p className="text-xs text-muted">{plural(folder.files.length, 'Markdown file')} read from {folder.label || 'the folder'}.</p>
          )}

          <Input className="max-w-xs" placeholder="Into folder (optional)" value={prefix}
                 onChange={(e) => { setPrefix(e.target.value); reset(); }} />

          {!preview && (
            <Button disabled={off || inputError !== null} onClick={() => void run('preview')}>
              {working === 'preview' ? 'Checking…' : working === 'read' ? 'Reading…' : 'Preview import'}
            </Button>
          )}

          {preview && (
            <Notice layout="stack">
              <p className="font-medium">{previewText(preview)}</p>
              {skips && <p>{skips}.</p>}
              {localSkips && <p>{localSkips}</p>}
              {redacted && <p>{redacted}.</p>}
              {collided && <p>{collided}</p>}
              <p className="text-xs">One commit, signed by you. Nothing is deleted; a page already at the same path is replaced.</p>
              <div className="flex gap-2">
                <Button variant="primary" disabled={off || preview.plan.kept === 0} onClick={() => void run('import')}>
                  {working === 'import' ? 'Importing and indexing…' : `Import ${plural(preview.plan.kept, 'page')}`}
                </Button>
                <Button disabled={off} onClick={reset}>Cancel</Button>
              </div>
              {working === 'import' && <p className="text-xs">A large folder takes a few minutes. Keep this page open.</p>}
            </Notice>
          )}

          {finished && <Notice tone={finished.tone}>{finished.text}</Notice>}
          {!preview && !finished && <p className="text-xs text-muted">{IMPORT_NOTICE}</p>}
          {problem && <div className="text-[length:var(--control-font)] text-danger">{problem}</div>}
        </>
      )}
    </div>
  );
}
