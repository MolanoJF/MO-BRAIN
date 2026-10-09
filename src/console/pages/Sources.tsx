import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  ApiError, credentialsApi, filesApi, myConnectionApi, schemaPacksApi, sourcesApi,
  type MyConnection, type PackDetail, type SourceSummary,
} from '../api.ts';
import { Badge, Button, Card, Empty, Icon, Input, Link, Notice, PageTitle, Select } from '../ui/index.tsx';
import { useOrg } from '../OrgContext.tsx';
import { useSource } from '../SourceContext.tsx';
import { RemotePanel, type RemoteApi } from '../RemotePanel.tsx';
import { inheritanceNote } from './Schema.tsx';

/* -------------------------------------------------------------------------
 * Pure helpers. Exported so test/unit/console-sources.test.ts can assert the
 * decisions and the copy without a DOM — the inherited-vs-override sentence, the
 * two-click destructive gate, the add-source validator and the "not listed"
 * honesty rule are all operator-facing state, not decoration.
 * ---------------------------------------------------------------------- */

/**
 * The server's own source-id guard (`SOURCE_ID` in
 * `src/control/routes/wizard.ts`), duplicated here on purpose: the console
 * bundle must not import server code that reaches the database. The value is
 * identical — `^[a-z0-9][a-z0-9-]{0,62}$`.
 */
export const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The server's `ISOLATION_NOTICE` (`src/control/routes/wizard.ts:32`), the same
 * words the wizard shows. Folders inside a Source are not access boundaries.
 */
export const ISOLATION_NOTICE =
  'A Source is a whole gbrain source. Folders inside it are NOT access boundaries — ' +
  'every member with read on that Source can retrieve everything in it via semantic search. ' +
  'If something needs isolation, it needs its own Source.';

/**
 * S6 Gate 2: `gbrain schema active --source <id>` ignores its argument at
 * 0.50.5.0, so there is NO honest per-Source pack readback. An override is the
 * STORED intent (`config get schema_pack.source.<id>`), and the page says so
 * rather than painting a resolved-looking green state.
 */
export const NO_SOURCE_READBACK_NOTICE =
  'gbrain at this version offers no per-Source pack readback, so this override is shown as the ' +
  'stored setting, not a resolved state.';

/** Additive-only, per S3: sync fills blanks and can never reclassify. */
export const BACKFILL_NOTICE =
  'Fills in pages in this Source that have no type yet. Already-typed pages keep their type — ' +
  'this never reclassifies.';

export function validSourceId(id: string): boolean {
  return SOURCE_ID.test(id);
}

/** The add-source validator. Null means the pair is acceptable, else the sentence. */
export function addSourceError(sourceId: string, name: string): string | null {
  if (sourceId.trim() === '') return 'A source id is required.';
  if (!validSourceId(sourceId)) {
    return 'The source id must start with a lowercase letter or digit and contain only lowercase ' +
      'letters, digits and hyphens (at most 63 characters).';
  }
  if (name.trim() === '') return 'A name is required.';
  return null;
}

/** The rename validator. Null means the name is acceptable and actually changes something. */
export function renameSourceError(current: string, next: string): string | null {
  if (next.trim() === '') return 'A name is required.';
  if (next.trim() === current.trim()) return 'That is already the name.';
  return null;
}

/** Shown when the Source being archived or removed is the member's own private Space. */
export const PRIVATE_RETIRE_NOTE =
  'This is your private Space, so your agent is disconnected from it too. You can create a new private Space afterwards.';

/** Toggle one Space id in the list of Spaces the member's agent reads. */
export function toggleRead(current: string[], id: string): string[] {
  return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}

/**
 * A source id from a display name, for the one-field "New source" form. Never
 * collides with `taken`, and always satisfies `SOURCE_ID`; `null` when the name
 * has no letters or digits to build one from.
 */
export function slugifySourceId(name: string, taken: readonly string[]): string | null {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 56).replace(/-+$/g, '');
  if (base === '') return null;
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** One line of git state for a collapsed row and for the connected panel. */
export function gitStatusText(src: Pick<SourceSummary, 'gitRemote' | 'gitStatus'>): string {
  if (!src.gitRemote) return 'No git remote';
  const g = src.gitStatus;
  if (!g) return 'Git connected';
  const drift = [
    g.uncommittedFiles > 0 ? `${g.uncommittedFiles} uncommitted` : null,
    g.unpushedCommits > 0 ? `${g.unpushedCommits} unpushed` : null,
  ].filter((x) => x !== null);
  return drift.length === 0 ? 'Git up to date' : `Git: ${drift.join(', ')}`;
}

/** The notice for gbrain's built-in `default` source, shown only when it holds pages. */
export function builtinDefaultText(pageCount: number): string {
  return `gbrain's built-in \`default\` source holds ${pageCount} page${pageCount === 1 ? '' : 's'} ` +
    `that aren't in any Space. They aren't shown in the console.`;
}

export function canAddSource(sourceId: string, name: string): boolean {
  return addSourceError(sourceId, name) === null;
}

/**
 * The inherited-vs-override sentence. Inherited rows name the brain default;
 * override rows are named as the STORED setting (never a green resolved state).
 */
export function sourcePackLabel(src: {
  pack: string | null; tier: string | null; inherited: boolean;
}): string {
  const note = inheritanceNote(src.inherited, src.pack);
  if (note !== null) return note;
  return `Stored per-Source override: ${src.pack ?? 'unknown pack'} (tier ${src.tier ?? 'unknown'})`;
}

/**
 * The two-click remove gate. `idle` is the first "Remove" click; a 409 with the
 * `--dry-run` preview moves it to `confirmable`; only then may the destructive
 * call be made. A preview that is empty is NOT a confirmation.
 */
export type RemoveConfirmState = 'idle' | 'awaiting-preview' | 'confirmable';

export function removeConfirmState(clicked: boolean, preview: string | null): RemoveConfirmState {
  if (!clicked) return 'idle';
  return preview !== null && preview.trim() !== '' ? 'confirmable' : 'awaiting-preview';
}

export function canConfirmRemove(clicked: boolean, preview: string | null): boolean {
  return removeConfirmState(clicked, preview) === 'confirmable';
}

/** A gbrain source the console cannot read is not "0 pages" — it is unlisted. */
export function pageCountText(src: Pick<SourceSummary, 'inGbrain' | 'pageCount'>, listOk: boolean): string {
  if (!listOk || !src.inGbrain) return 'not listed by gbrain';
  return src.pageCount === null ? 'page count unknown' : `${src.pageCount} page${src.pageCount === 1 ? '' : 's'}`;
}

export function lastSyncText(src: Pick<SourceSummary, 'inGbrain' | 'lastSyncAt'>, listOk: boolean): string {
  if (!listOk || !src.inGbrain) return 'never (unlisted)';
  return src.lastSyncAt === null ? 'never synced' : `last sync ${new Date(src.lastSyncAt).toLocaleString()}`;
}

function reason(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message !== '') return e.message;
  return 'Request failed';
}

export { REMOTE_NOTICE, canSetRemote, pushText, remoteError } from '../RemotePanel.tsx';

/** Every Source goes through the one route set; the server decides who may manage which. */
const remoteApiFor = (sourceId: string): RemoteApi => ({
  set: (body) => sourcesApi.setRemote(sourceId, body),
  push: () => sourcesApi.pushRemote(sourceId),
  clear: () => sourcesApi.clearRemote(sourceId),
});

/** A quiet text action: the maintenance verbs are rare, so they don't get button chrome. */
function TextButton({ danger, className, ...rest }: { danger?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button"
            className={`text-[length:var(--control-font)] underline-offset-2 enabled:hover:underline disabled:opacity-45 ${
              danger ? 'text-danger' : 'text-muted enabled:hover:text-text'} ${className ?? ''}`}
            {...rest} />
  );
}

type Pending = 'archive' | 'remove' | 'rename' | null;

type Shared = {
  listOk: boolean;
  packs: PackDetail[];
  busy: string | null;
  tokenStored: (src: SourceSummary) => boolean | null;
  reload: () => Promise<void>;
  step: (id: string, fn: () => Promise<void>) => Promise<void>;
};

/**
 * One Source. Collapsed it is a name, three facts and (for a company Source) the
 * agent switch — no buttons. Opening it shows the two things you configure
 * (schema, git) and a single line of maintenance verbs; Archive and Remove ask
 * for confirmation in place.
 */
function SourceRow({ src, open, onToggle, shared, agent }: {
  src: SourceSummary;
  open: boolean;
  onToggle: () => void;
  shared: Shared;
  agent: { visible: boolean; on: boolean; disabled: boolean; toggle: () => void };
}) {
  const { listOk, packs, busy, reload, step } = shared;
  const { reload: reloadSources } = useSource();
  const [pending, setPending] = useState<Pending>(null);
  const [name, setName] = useState(src.name);
  const [removePreview, setRemovePreview] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const idle = busy === null;

  const run = (fn: () => Promise<void>) => step(src.sourceId, async () => {
    setProblem(null);
    try { await fn(); } catch (e) { setProblem(reason(e)); }
  });

  const options = src.pack && !packs.some((p) => p.name === src.pack)
    ? [src.pack, ...packs.map((p) => p.name)] : packs.map((p) => p.name);

  const setPack = (pack: string) => run(async () => { await schemaPacksApi.setSourcePack(src.sourceId, pack); await reload(); });
  const resetPack = () => run(async () => { await schemaPacksApi.resetSourcePack(src.sourceId); await reload(); });
  const backfill = () => run(async () => {
    const r = await schemaPacksApi.runSync(src.sourceId);
    setResult(r.total_applied === 0 ? 'Every page already has a type.' : `Typed ${r.total_applied} page${r.total_applied === 1 ? '' : 's'}.`);
    await reload();
  });
  const saveName = () => run(async () => {
    const invalid = renameSourceError(src.name, name);
    if (invalid !== null) { setProblem(invalid); return; }
    await sourcesApi.rename(src.sourceId, name.trim());
    setPending(null);
    await reload();
    await reloadSources();
  });
  const archive = () => run(async () => { await sourcesApi.remove(src.sourceId, { mode: 'archive' }); await reload(); });
  // The first Remove click is a PROBE, not the deletion: an unconfirmed remove
  // answers 409 with gbrain's `--dry-run` impact preview, which must be seen
  // before the destructive call is unlocked (`canConfirmRemove`).
  const probeRemove = () => run(async () => {
    setPending('remove'); setRemovePreview(null);
    try {
      await sourcesApi.remove(src.sourceId, { mode: 'remove' });
      setPending(null); await reload();
    } catch (e) {
      if (e instanceof ApiError && e.body.error === 'confirmation_required') {
        setRemovePreview(typeof e.body.preview === 'string' ? e.body.preview : '');
        return;
      }
      throw e;
    }
  });
  const confirmRemove = () => run(async () => {
    if (!canConfirmRemove(pending === 'remove', removePreview)) return;
    await sourcesApi.remove(src.sourceId, { mode: 'remove', confirm: true });
    setPending(null); setRemovePreview(null);
    await reload();
  });
  const cancel = () => { setPending(null); setRemovePreview(null); setName(src.name); setProblem(null); };

  return (
    <Card className="!p-0">
      <div className="flex items-center gap-3 px-5 py-4">
        <button type="button" aria-expanded={open} onClick={onToggle}
                className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <Icon glyph={ChevronRight} size={14} className={open ? 'rotate-90 text-muted' : 'text-muted'} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{src.name}</span>
            <span className="block truncate text-[length:var(--control-font)] text-muted">
              {src.pack ?? 'no schema'} · {pageCountText(src, listOk)} · {gitStatusText(src)}
            </span>
          </span>
        </button>
        {agent.visible && (
          <label className="flex shrink-0 items-center gap-2 text-[length:var(--control-font)] text-muted">
            <input type="checkbox" checked={agent.on} disabled={agent.disabled} onChange={agent.toggle} />
            Agent reads
          </label>
        )}
      </div>

      {open && (
        <div className="space-y-5 border-t border-border px-5 py-4">
          <div className="space-y-1">
            <div className="text-[length:var(--control-font)] font-medium">Schema</div>
            {src.canManage ? (
              <div className="flex flex-wrap items-center gap-2">
                <Select className="max-w-xs" value={src.pack ?? ''} disabled={!idle}
                        onChange={(e) => void setPack(e.currentTarget.value)}>
                  {options.length === 0 && <option value="">(no schemas available)</option>}
                  {options.map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
                {src.inherited
                  ? <span className="text-xs text-muted">Brain default</span>
                  : <TextButton disabled={!idle} onClick={() => void resetPack()}>Use brain default</TextButton>}
              </div>
            ) : (
              <div className="text-[length:var(--control-font)]">{src.pack ?? 'none'}</div>
            )}
            <p className="text-xs text-muted">Edit a schema's page types under Schema.</p>
          </div>

          {src.canManage && (
            <RemotePanel sourceId={src.sourceId} gitRemote={src.gitRemote} status={gitStatusText(src)}
                         busy={!idle} api={remoteApiFor(src.sourceId)} onChanged={reload}
                         token={{ stored: shared.tokenStored(src), scope: src.private ? 'member' : 'org' }} />
          )}

          {src.canManage && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <TextButton disabled={!idle} onClick={() => void backfill()}>Backfill types</TextButton>
                <Link href={filesApi.exportUrl(src.sourceId)} download>Export</Link>
                <TextButton disabled={!idle} onClick={() => { setName(src.name); setPending('rename'); }}>Rename</TextButton>
                <TextButton disabled={!idle} onClick={() => setPending('archive')}>Archive</TextButton>
                <TextButton danger disabled={!idle} onClick={() => void probeRemove()}>Remove</TextButton>
              </div>

              {pending === null && result === null && <p className="text-xs text-muted">{BACKFILL_NOTICE}</p>}
              {result && pending === null && <p className="text-[length:var(--control-font)]">{result}</p>}

              {pending === 'rename' && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input aria-label="Source name" className="max-w-xs" value={name} onChange={(e) => setName(e.target.value)} />
                  <Button variant="primary" disabled={!idle || renameSourceError(src.name, name) !== null}
                          onClick={() => void saveName()}>Save</Button>
                  <Button onClick={cancel}>Cancel</Button>
                </div>
              )}

              {pending === 'archive' && (
                <Notice layout="stack">
                  <p>Archiving hides {src.name} from search and keeps its data for 72 hours.</p>
                  {src.private && <p>{PRIVATE_RETIRE_NOTE}</p>}
                  <div className="flex gap-2">
                    <Button variant="danger" disabled={!idle} onClick={() => void archive()}>Archive {src.name}</Button>
                    <Button onClick={cancel}>Keep it</Button>
                  </div>
                </Notice>
              )}

              {pending === 'remove' && removePreview !== null && (
                <Notice layout="stack">
                  <p className="font-medium">Remove — impact preview</p>
                  <pre className="text-xs whitespace-pre-wrap font-mono">{removePreview}</pre>
                  {src.private && <p>{PRIVATE_RETIRE_NOTE}</p>}
                  <div className="flex gap-2">
                    <Button variant="danger" disabled={!idle || !canConfirmRemove(true, removePreview)}
                            onClick={() => void confirmRemove()}>Confirm remove</Button>
                    <Button onClick={cancel}>Keep it</Button>
                  </div>
                </Notice>
              )}
            </div>
          )}

          {problem && <div className="text-[length:var(--control-font)] text-danger">{problem}</div>}
        </div>
      )}
    </Card>
  );
}

/**
 * The one Sources page: the Sources you own and the ones shared with you, in the
 * same two groups as the sidebar. `canManage` (from the server) decides what a
 * row offers; nobody is shown a control the server would refuse.
 */
export function Sources() {
  const { org } = useOrg();
  const isAdmin = org?.role === 'owner' || org?.role === 'admin';
  const { reload: reloadSources } = useSource();
  const [rows, setRows] = useState<SourceSummary[] | null>(null);
  const [unregistered, setUnregistered] = useState<string[]>([]);
  const [builtinDefault, setBuiltinDefault] = useState<{ pageCount: number } | null>(null);
  const [listOk, setListOk] = useState(true);
  const [packs, setPacks] = useState<PackDetail[]>([]);
  const [mine, setMine] = useState<MyConnection | null>(null);
  const [tokens, setTokens] = useState<{ member: boolean; org: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const load = async () => {
    const body = await sourcesApi.list();
    setRows(body.sources);
    setUnregistered(body.unregistered);
    setBuiltinDefault(body.builtinDefault ?? null);
    setListOk(body.sourcesListOk);
    // Not every member has an agent connection yet; the page works without one.
    setMine(await myConnectionApi.get().catch(() => null));
  };
  useEffect(() => { void load().catch((e) => setError(reason(e))); }, []);
  useEffect(() => {
    void schemaPacksApi.list().then((b) => setPacks(b.packs)).catch(() => undefined);
    void credentialsApi.status()
      .then((c) => setTokens({ member: c.github.member.configured, org: c.github.org?.configured ?? false }))
      .catch(() => setTokens({ member: false, org: false }));
  }, []);

  const step = async (id: string, fn: () => Promise<void>) => {
    setBusy(id); setError(null);
    try { await fn(); } catch (e) { setError(reason(e)); } finally { setBusy(null); }
  };

  const reload = async () => { await load(); };

  const readIds = mine?.connection?.readSpaceIds ?? [];
  const readable = new Map((mine?.readable ?? []).map((s) => [s.sourceId, s.id]));
  const agentFor = (src: SourceSummary) => {
    const spaceId = readable.get(src.sourceId);
    const live = mine?.connection != null && spaceId !== undefined && !src.private;
    return {
      visible: live,
      on: spaceId !== undefined && readIds.includes(spaceId),
      disabled: busy !== null || mine?.connection?.state !== 'active',
      toggle: () => void step('agent', async () => {
        if (spaceId === undefined) return;
        await myConnectionApi.setReads(toggleRead(readIds, spaceId));
        await load();
      }),
    };
  };

  const shared: Shared = {
    listOk, packs, busy, reload, step,
    tokenStored: (src) => (tokens === null ? null : src.private ? tokens.member : tokens.org),
  };

  const create = () => step('add', async () => {
    const id = slugifySourceId(newName, (rows ?? []).map((r) => r.sourceId));
    const invalid = id === null ? 'Give the Source a name.' : addSourceError(id, newName);
    if (invalid !== null || id === null) { setError(invalid); return; }
    await sourcesApi.add({ sourceId: id, name: newName.trim() });
    setNewName(''); setCreating(false);
    await load();
    await reloadSources();
    setOpen(id);
  });

  const createPrivate = () => step('private', async () => {
    await myConnectionApi.createSpace();
    await load();
    await reloadSources();
  });

  const groups = [
    { label: 'My Brain', rows: (rows ?? []).filter((r) => r.private) },
    { label: 'Company', rows: (rows ?? []).filter((r) => !r.private) },
  ].filter((g) => g.rows.length > 0);

  return (
    <div className="max-w-3xl space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <PageTitle>Sources</PageTitle>
          <p className="text-sm text-muted">Where your pages live. Open a Source to change its schema or git remote.</p>
        </div>
        {isAdmin && !creating && <Button className="shrink-0" onClick={() => setCreating(true)}>New source</Button>}
      </header>

      {error && <div className="text-[length:var(--control-font)] text-danger">{error}</div>}
      {!listOk && (
        <div className="text-[length:var(--control-font)] text-warning">
          gbrain's source list could not be read, so live page counts and sync times are unavailable.
        </div>
      )}

      {creating && (
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="New source name" autoFocus className="max-w-xs" placeholder="Name" value={newName}
                   onChange={(e) => setNewName(e.target.value)} />
            <Button variant="primary" disabled={busy !== null || newName.trim() === ''} onClick={() => void create()}>
              {busy === 'add' ? 'Creating…' : 'Create'}
            </Button>
            <Button onClick={() => { setCreating(false); setNewName(''); }}>Cancel</Button>
          </div>
          <p className="mt-2 text-xs text-muted">{ISOLATION_NOTICE}</p>
        </Card>
      )}

      {rows === null && !error && <p className="text-sm text-muted">Loading…</p>}
      {rows !== null && rows.length === 0 && <Empty>No Sources yet.</Empty>}
      {rows !== null && !rows.some((r) => r.private) && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">You don't have a private Space.</p>
            <Button disabled={busy !== null} onClick={() => void createPrivate()}>
              {busy === 'private' ? 'Creating…' : 'Create private Space'}
            </Button>
          </div>
        </Card>
      )}

      {groups.map((g) => (
        <section key={g.label} className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted">{g.label}</h2>
          {g.rows.map((src) => (
            <SourceRow key={src.sourceId} src={src} shared={shared} agent={agentFor(src)}
                       open={open === src.sourceId}
                       onToggle={() => setOpen(open === src.sourceId ? null : src.sourceId)} />
          ))}
        </section>
      ))}

      {builtinDefault !== null && (
        <Notice layout="stack"><p>{builtinDefaultText(builtinDefault.pageCount)}</p></Notice>
      )}

      {unregistered.length > 0 && (
        <section className="space-y-1">
          <h2 className="font-medium">Unregistered sources</h2>
          <p className="text-sm text-muted">
            These gbrain sources have no Source in this organization, so the console cannot manage them:
          </p>
          <div className="text-sm font-mono">{unregistered.join(', ')}</div>
        </section>
      )}
    </div>
  );
}
