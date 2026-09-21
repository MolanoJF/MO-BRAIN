import { useEffect, useState } from 'react';
import {
  ApiError, schemaPacksApi, sourcesApi,
  type PackDetail, type SchemaSync, type SourceSummary,
} from '../api.ts';
import { PackTypesView, SyncTable, inheritanceNote } from './Schema.tsx';

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
 * words the wizard shows. Folders inside a Space are not access boundaries.
 */
export const ISOLATION_NOTICE =
  'A Space is a whole gbrain source. Folders inside it are NOT access boundaries — ' +
  'every member with read on that Space can retrieve everything in it via semantic search. ' +
  'If something needs isolation, it needs its own Space.';

/**
 * S6 Gate 2: `gbrain schema active --source <id>` ignores its argument at
 * 0.50.5.0, so there is NO honest per-Space pack readback. An override is the
 * STORED intent (`config get schema_pack.source.<id>`), and the page says so
 * rather than painting a resolved-looking green state.
 */
export const NO_SOURCE_READBACK_NOTICE =
  'gbrain at this version offers no per-Space pack readback, so this override is shown as the ' +
  'stored setting, not a resolved state.';

/** Additive-only, per S3: sync fills blanks and can never reclassify. */
export const BACKFILL_NOTICE =
  'Fills in pages in this Space that have no type yet. Already-typed pages keep their type — ' +
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
  return `Stored per-Space override: ${src.pack ?? 'unknown pack'} (tier ${src.tier ?? 'unknown'})`;
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

export function Sources() {
  const [rows, setRows] = useState<SourceSummary[]>([]);
  const [unregistered, setUnregistered] = useState<string[]>([]);
  const [listOk, setListOk] = useState(true);
  const [details, setDetails] = useState<PackDetail[]>([]);
  const [packs, setPacks] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [removePreview, setRemovePreview] = useState<string | null>(null);
  const [sync, setSync] = useState<{ sourceId: string; preview: SchemaSync; applied: SchemaSync } | null>(null);

  const load = async () => {
    const body = await sourcesApi.list();
    setRows(body.sources);
    setUnregistered(body.unregistered);
    setListOk(body.sourcesListOk);
  };
  useEffect(() => { void load().catch((e) => setError(reason(e))); }, []);
  useEffect(() => {
    void schemaPacksApi.list()
      .then((body) => { setDetails(body.packs); setPacks(body.packs.map((p) => p.name)); })
      .catch(() => undefined);
  }, []);

  const step = async (id: string, fn: () => Promise<void>) => {
    setBusy(id); setError(null);
    try { await fn(); }
    catch (e) { setError(reason(e)); }
    finally { setBusy(null); }
  };

  const setPack = (src: SourceSummary, pack: string) => step(src.sourceId, async () => {
    await schemaPacksApi.setSourcePack(src.sourceId, pack);
    await load();
  });

  const resetPack = (src: SourceSummary) => step(src.sourceId, async () => {
    await schemaPacksApi.resetSourcePack(src.sourceId);
    await load();
  });

  const archive = (src: SourceSummary) => step(src.sourceId, async () => {
    await sourcesApi.remove(src.sourceId, { mode: 'archive' });
    await load();
  });

  // The first click is a PROBE, not the deletion: an unconfirmed remove answers
  // 409 with the `--dry-run` impact preview, which is held until the operator
  // confirms. A server that somehow answers success here just reloads.
  const requestRemove = (src: SourceSummary) => step(src.sourceId, async () => {
    setRemoveTarget(src.sourceId);
    setRemovePreview(null);
    try {
      await sourcesApi.remove(src.sourceId, { mode: 'remove' });
      setRemoveTarget(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.body.error === 'confirmation_required') {
        setRemovePreview(typeof e.body.preview === 'string' ? e.body.preview : '');
        return;
      }
      throw e;
    }
  });

  const confirmRemove = (src: SourceSummary) => step(src.sourceId, async () => {
    if (!canConfirmRemove(removeTarget === src.sourceId, removePreview)) return;
    await sourcesApi.remove(src.sourceId, { mode: 'remove', confirm: true });
    setRemoveTarget(null);
    setRemovePreview(null);
    await load();
  });

  const backfill = (src: SourceSummary) => step(src.sourceId, async () => {
    const preview = await schemaPacksApi.previewSync(src.sourceId);
    const applied = await schemaPacksApi.runSync(src.sourceId);
    setSync({ sourceId: src.sourceId, preview, applied });
    await load();
  });

  const add = () => step('add', async () => {
    const invalid = addSourceError(newId, newName);
    if (invalid !== null) { setError(invalid); return; }
    const r = await sourcesApi.add({ sourceId: newId, name: newName });
    setNotice(r.isolationNotice);
    setNewId('');
    setNewName('');
    await load();
  });

  const detailFor = (pack: string | null): PackDetail | null =>
    pack === null ? null : details.find((d) => d.name === pack) ?? null;

  return (
    <div className="max-w-3xl space-y-8">
      <header>
        <h1 className="text-xl font-semibold">Sources</h1>
        <p className="text-sm text-muted">
          Every Space is a gbrain source. Set each one's schema pack, backfill its blank page types,
          and add or retire sources.
        </p>
      </header>

      {error && <div className="text-danger text-sm">{error}</div>}
      {!listOk && (
        <div className="text-warning text-sm">
          gbrain's source list could not be read, so live page counts and sync times are unavailable.
        </div>
      )}

      <section className="space-y-3">
        <h2 className="font-medium">Spaces</h2>
        {rows.length === 0 && <p className="text-sm text-muted">No Spaces yet.</p>}
        {rows.map((src) => {
          const detail = detailFor(src.pack);
          const isOpen = expanded === src.sourceId;
          const clicked = removeTarget === src.sourceId;
          const options = src.pack && !packs.includes(src.pack) ? [src.pack, ...packs] : packs;
          return (
            <div key={src.sourceId} className="card space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div>{src.name}</div>
                  <div className="text-sm text-muted font-mono">{src.sourceId} · {src.kind}</div>
                  <div className="text-sm text-muted">
                    {pageCountText(src, listOk)} · {lastSyncText(src, listOk)}
                    {src.federated === null ? '' : ` · federated ${src.federated ? 'yes' : 'no'}`}
                  </div>
                </div>
                <button className="nav-item shrink-0" disabled={busy !== null}
                        onClick={() => setExpanded(isOpen ? null : src.sourceId)}>
                  {isOpen ? 'Hide types' : 'View types'}
                </button>
              </div>

              <div className="space-y-1">
                <div className="text-sm">{sourcePackLabel(src)}</div>
                {!src.inherited && <p className="text-xs text-muted">{NO_SOURCE_READBACK_NOTICE}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="field max-w-xs"
                    value={src.pack ?? ''}
                    disabled={busy !== null}
                    onChange={(e) => void setPack(src, e.currentTarget.value)}
                  >
                    {options.length === 0 && <option value="">(no packs available)</option>}
                    {options.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  {!src.inherited && (
                    <button className="nav-item w-auto" disabled={busy !== null}
                            onClick={() => void resetPack(src)}>
                      Reset to brain default
                    </button>
                  )}
                </div>
              </div>

              {isOpen && (
                detail
                  ? <PackTypesView detail={detail} />
                  : <p className="text-sm text-muted">
                      No resolved details for {src.pack ?? 'this pack'}.
                    </p>
              )}

              <div className="flex flex-wrap gap-2">
                <button className="nav-item w-auto" disabled={busy !== null} onClick={() => void backfill(src)}>
                  Backfill blank types
                </button>
                <button className="nav-item w-auto" disabled={busy !== null} onClick={() => void archive(src)}>
                  Archive
                </button>
                {clicked ? (
                  <>
                    <button
                      className="nav-item w-auto text-danger"
                      disabled={busy !== null || !canConfirmRemove(clicked, removePreview)}
                      onClick={() => void confirmRemove(src)}
                    >
                      Confirm remove
                    </button>
                    <button className="nav-item w-auto"
                            onClick={() => { setRemoveTarget(null); setRemovePreview(null); }}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <button className="nav-item w-auto text-danger" disabled={busy !== null}
                          onClick={() => void requestRemove(src)}>
                    Remove
                  </button>
                )}
              </div>
              <p className="text-xs text-muted">{BACKFILL_NOTICE}</p>

              {clicked && removePreview !== null && (
                <div className="card border-warning space-y-1">
                  <p className="text-sm font-medium">Remove — impact preview</p>
                  <pre className="text-xs whitespace-pre-wrap font-mono">{removePreview}</pre>
                </div>
              )}

              {sync?.sourceId === src.sourceId && (
                <div className="space-y-3">
                  <SyncTable title="Backfill preview — nothing written" report={sync.preview} />
                  <SyncTable title={`Backfilled — ${sync.applied.total_applied} page(s) typed`} report={sync.applied} />
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Add source</h2>
        <input className="field" placeholder="source-id" value={newId}
               onChange={(e) => setNewId(e.target.value)} />
        <input className="field" placeholder="Name" value={newName}
               onChange={(e) => setNewName(e.target.value)} />
        <button className="btn-primary" disabled={busy !== null || !canAddSource(newId, newName)}
                onClick={() => void add()}>
          {busy === 'add' ? 'Adding…' : 'Add source'}
        </button>
        <p className="text-sm text-muted">{notice ?? ISOLATION_NOTICE}</p>
      </section>

      {unregistered.length > 0 && (
        <section className="space-y-1">
          <h2 className="font-medium">Unregistered sources</h2>
          <p className="text-sm text-muted">
            These gbrain sources have no Space in this organization, so the console cannot manage them:
          </p>
          <div className="text-sm font-mono">{unregistered.join(', ')}</div>
        </section>
      )}
    </div>
  );
}
