import { useEffect, useState } from 'react';
import {
  ApiError, schemaPacksApi,
  type PackDetail, type PackDetailResponse, type PackMutateResult,
  type SchemaLint, type ScaffoldResult,
} from '../api.ts';
import type { PackDraft, PackMutation } from '../../control/schemaDraft.ts';
import { Badge, Button, Card, Empty, Field, Input, Select, Table, TableWrap, Textarea, Toolbar } from '../ui/index.tsx';

const IRREGULAR: Record<string, string> = { person: 'people', company: 'companies', media: 'media', analysis: 'analyses' };

export function folderFor(type: string): string {
  const t = type.trim().toLowerCase().replace(/_/g, '-');
  if (!t) return '';
  const parts = t.split('-');
  const last = parts.pop()!;
  const plural = IRREGULAR[last] ?? (/(s|x|ch|sh)$/.test(last) ? `${last}es` : /[^aeiou]y$/.test(last) ? `${last.slice(0, -1)}ies` : `${last}s`);
  return `${[...parts, plural].join('-')}/`;
}

export function emptyDraft(parent: string | null): PackDraft {
  return { name: '', description: '', extends: parent, pageTypes: [], linkVerbs: [] };
}

export function draftFromJson(text: string): { ok: true; draft: PackDraft } | { ok: false; error: string } {
  try { return { ok: true, draft: JSON.parse(text) as PackDraft }; }
  catch (e) { return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
}

type EditType = { name: string; primitive: string; pathPrefixes: string[]; aliases: string[]; extractable: boolean; expertRouting: boolean };
type EditLink = { name: string; inverse: string | null; pageType: string | null; targetType: string | null };
type EditState = { pageTypes: EditType[]; linkTypes: EditLink[] };

/**
 * The editor holds the pack's OWN declarations as local state; Save diffs
 * that against what was loaded and sends ONE batch, which gbrain applies
 * atomically or not at all. Order matters to gbrain's reference checks:
 * removals first, then adds, then per-type edits, then new verbs.
 */
export function editsToMutations(before: EditState, after: EditState): PackMutation[] {
  const out: PackMutation[] = [];
  const b = new Map(before.pageTypes.map((t) => [t.name, t]));
  const a = new Map(after.pageTypes.map((t) => [t.name, t]));
  const bl = new Map(before.linkTypes.map((l) => [l.name, l]));
  const al = new Map(after.linkTypes.map((l) => [l.name, l]));
  const sameLink = (x: EditLink, y: EditLink) => x.inverse === y.inverse && x.pageType === y.pageType && x.targetType === y.targetType;

  for (const [n, l] of bl) if (!al.has(n) || !sameLink(l, al.get(n)!)) out.push({ op: 'remove_link_type', name: n });
  for (const n of b.keys()) if (!a.has(n)) out.push({ op: 'remove_type', name: n });
  for (const [n, t] of a) {
    if (b.has(n)) continue;
    out.push({ op: 'add_type', name: n, primitive: t.primitive as never, prefix: t.pathPrefixes[0]!,
      extractable: t.extractable, expert_routing: t.expertRouting, aliases: t.aliases });
    for (const p of t.pathPrefixes.slice(1)) out.push({ op: 'add_prefix', type: n, prefix: p });
  }
  for (const [n, t] of a) {
    const old = b.get(n);
    if (!old) continue;
    for (const p of t.pathPrefixes) if (!old.pathPrefixes.includes(p)) out.push({ op: 'add_prefix', type: n, prefix: p });
    for (const p of old.pathPrefixes) if (!t.pathPrefixes.includes(p)) out.push({ op: 'remove_prefix', type: n, prefix: p });
    for (const x of t.aliases) if (!old.aliases.includes(x)) out.push({ op: 'add_alias', type: n, alias: x });
    for (const x of old.aliases) if (!t.aliases.includes(x)) out.push({ op: 'remove_alias', type: n, alias: x });
    if (t.primitive !== old.primitive) out.push({ op: 'update_type', name: n, patch: { primitive: t.primitive as never } });
    if (t.extractable !== old.extractable) out.push({ op: 'set_extractable', type: n, value: t.extractable });
    if (t.expertRouting !== old.expertRouting) out.push({ op: 'set_expert_routing', type: n, value: t.expertRouting });
  }
  for (const [n, l] of al) {
    const old = bl.get(n);
    if (old && sameLink(old, l)) continue;
    const inference = l.pageType || l.targetType
      ? { ...(l.pageType ? { page_type: l.pageType } : {}), ...(l.targetType ? { target_type: l.targetType } : {}) } : undefined;
    out.push({ op: 'add_link_type', name: n, ...(l.inverse ? { inverse: l.inverse } : {}), ...(inference ? { inference } : {}) });
  }
  return out;
}

/**
 * The builder sentence. A created type's folder is scaffolded into every Space
 * that resolves the pack, but the pages already there keep the type they were
 * given — sync only fills a blank one (S3). Saying both is the point.
 */
export const ADDITIVE_BUILDER_NOTICE =
  'Adding a type creates its folder in every Space using this pack. Existing pages keep their type; ' +
  'Sync fills in pages that have none.';

const PRIMITIVES = ['entity', 'media', 'temporal', 'annotation', 'concept'] as const;
const splitList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

type DesignPageType = {
  name: string; primitive: string; folder: string; description: string;
  extraPrefixes: string; aliases: string; extractable: boolean; expertRouting: boolean; folderEdited: boolean;
};
type DesignLinkVerb = { name: string; inverse: string; fromType: string; toType: string };

const blankType = (): DesignPageType => ({
  name: '', primitive: 'entity', folder: '', description: '',
  extraPrefixes: '', aliases: '', extractable: false, expertRouting: false, folderEdited: false,
});
const blankVerb = (): DesignLinkVerb => ({ name: '', inverse: '', fromType: '', toType: '' });

function LintView({ lint }: { lint: SchemaLint }) {
  return (
    <section className="mt-3 space-y-1">
      <h3 className="text-xs font-semibold text-muted">Lint — {lint.ok ? 'clean' : 'errors'}</h3>
      {lint.errors.map((e, i) => (
        <div key={`e${i}`} className="text-[length:var(--control-font)] text-danger">
          <code>{e.rule}</code>: {e.message}{e.hint ? ` — ${e.hint}` : ''}
        </div>
      ))}
      {lint.warnings.map((w, i) => (
        <div key={`w${i}`} className="text-[length:var(--control-font)] text-muted">
          <code>{w.rule}</code>: {w.message}{w.hint ? ` — ${w.hint}` : ''}
        </div>
      ))}
    </section>
  );
}

/**
 * Per-Space scaffolding results, one line each. Never collapsed into one green
 * summary: a Space whose pack failed to resolve, or whose git commit failed,
 * carries its own error and must not be hidden behind a sibling's success.
 */
export function ScaffoldResults({ results }: { results: ScaffoldResult[] }) {
  if (results.length === 0) return <Empty>No Spaces to scaffold.</Empty>;
  return (
    <div className="mt-3 space-y-1">
      <h3 className="text-xs font-semibold text-muted">Folders</h3>
      {results.map((r) => (
        <div key={r.sourceId} className="text-[length:var(--control-font)]">
          <code>{r.sourceId}</code>
          {r.error
            ? <span className="text-danger"> — {r.error}</span>
            : (
              <span className="text-muted">
                {' — '}created {r.created.length} folder{r.created.length === 1 ? '' : 's'}
                {r.created.length > 0 ? ` in ${r.sourceId}: ${r.created.join(', ')}` : ''}
                {r.skipped.length > 0 ? ` (${r.skipped.length} already there)` : ''}
              </span>
            )}
        </div>
      ))}
    </div>
  );
}

/**
 * Create a custom pack three ways, against the same API the Advanced YAML path
 * uses. The Design tab is the only one that builds a whole document; "From
 * template" forks a bundled pack, and "Import draft" only parses an agent's
 * draft into the Design tab so the admin reviews it before anything is written.
 */
export function NewPackPanel({ parent, packs, onCreated }: {
  parent: string | null;
  packs: PackDetail[];
  onCreated: () => void;
}) {
  const [tab, setTab] = useState<'design' | 'template' | 'import'>('design');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [buildsOn, setBuildsOn] = useState(parent ?? '');
  const [types, setTypes] = useState<DesignPageType[]>([blankType()]);
  const [verbs, setVerbs] = useState<DesignLinkVerb[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [gbrainError, setGbrainError] = useState<string | null>(null);
  const [lint, setLint] = useState<SchemaLint | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forkFrom, setForkFrom] = useState(packs[0]?.name ?? '');
  const [forkName, setForkName] = useState('');
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);

  const packNames = packs.map((p) => p.name);

  const step = async (fn: () => Promise<void>) => {
    setBusy(true); setErrors([]); setGbrainError(null); setLint(null);
    try { await fn(); }
    catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as { errors?: unknown; error?: unknown; lint?: unknown };
        if (Array.isArray(body.errors)) setErrors(body.errors.filter((x): x is string => typeof x === 'string'));
        if (typeof body.error === 'string') setGbrainError(body.error);
        if (body.lint) setLint(body.lint as SchemaLint);
        if (!body.errors && typeof body.error !== 'string') setGbrainError(e.message);
      } else setGbrainError(e instanceof Error ? e.message : 'Request failed');
    } finally { setBusy(false); }
  };

  const updateType = (i: number, patch: Partial<DesignPageType>) => {
    setTypes((prev) => prev.map((t, j) => {
      if (j !== i) return t;
      const next = { ...t, ...patch };
      if (patch.name !== undefined && !t.folderEdited) next.folder = folderFor(patch.name);
      return next;
    }));
  };

  const submitDraft = () => step(async () => {
    const draft: PackDraft = {
      name: name.trim(), description: description.trim(), extends: buildsOn || null,
      pageTypes: types.filter((t) => t.name.trim() !== '').map((t) => ({
        name: t.name.trim(), primitive: t.primitive as PackDraft['pageTypes'][number]['primitive'],
        folder: t.folder.trim(), description: t.description.trim(),
        extraPrefixes: splitList(t.extraPrefixes), aliases: splitList(t.aliases),
        extractable: t.extractable, expertRouting: t.expertRouting,
      })),
      linkVerbs: verbs.filter((v) => v.name.trim() !== '').map((v) => ({
        name: v.name.trim(), inverse: v.inverse.trim() || undefined,
        fromType: v.fromType.trim() || undefined, toType: v.toType.trim() || undefined,
      })),
    };
    const r = await schemaPacksApi.create({ mode: 'draft', draft });
    setGbrainError(r.error); setLint(r.lint);
    if (r.ok) { setCreated(r.name); onCreated(); }
  });

  const submitFork = () => step(async () => {
    const r = await schemaPacksApi.create({ mode: 'fork', from: forkFrom, name: forkName.trim() });
    setGbrainError(r.error); setLint(r.lint);
    if (r.ok) { setCreated(r.name); onCreated(); }
  });

  const reviewImport = () => {
    const r = draftFromJson(importText);
    if (!r.ok) { setImportError(r.error); return; }
    setImportError(null);
    setName(typeof r.draft.name === 'string' ? r.draft.name : '');
    setDescription(typeof r.draft.description === 'string' ? r.draft.description : '');
    setBuildsOn(typeof r.draft.extends === 'string' ? r.draft.extends : '');
    setTypes((Array.isArray(r.draft.pageTypes) ? r.draft.pageTypes : []).map((t) => ({
      name: String(t.name ?? ''), primitive: String(t.primitive ?? 'entity'), folder: String(t.folder ?? ''),
      description: String(t.description ?? ''),
      extraPrefixes: (t.extraPrefixes ?? []).join(', '), aliases: (t.aliases ?? []).join(', '),
      extractable: t.extractable === true, expertRouting: t.expertRouting === true, folderEdited: true,
    })));
    setVerbs((Array.isArray(r.draft.linkVerbs) ? r.draft.linkVerbs : []).map((v) => ({
      name: String(v.name ?? ''), inverse: String(v.inverse ?? ''),
      fromType: String(v.fromType ?? ''), toType: String(v.toType ?? ''),
    })));
    setTab('design');
  };

  return (
    <Card title="New pack">
      <Toolbar>
        <Button variant={tab === 'design' ? 'primary' : 'secondary'} aria-pressed={tab === 'design'} disabled={busy} onClick={() => setTab('design')}>Design</Button>
        <Button variant={tab === 'template' ? 'primary' : 'secondary'} aria-pressed={tab === 'template'} disabled={busy} onClick={() => setTab('template')}>From template</Button>
        <Button variant={tab === 'import' ? 'primary' : 'secondary'} aria-pressed={tab === 'import'} disabled={busy} onClick={() => setTab('import')}>Import draft</Button>
      </Toolbar>

      {tab === 'design' && (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-muted">{ADDITIVE_BUILDER_NOTICE}</p>
          <div className="flex flex-wrap gap-3">
            <Field label="Name" id="np-name" hint="lowercase letters, digits and hyphens">
              <Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="legal-ops" />
            </Field>
            <Field label="Builds on" id="np-extends">
              <Select id="np-extends" value={buildsOn} onChange={(e) => setBuildsOn(e.target.value)}>
                <option value="">Nothing — standalone</option>
                {packNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Description" id="np-desc">
            <Input id="np-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>

          <div>
            <h3 className="text-xs font-semibold text-muted">Page types</h3>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <th>Name</th><th>Primitive</th><th>Folder</th><th>Extra prefixes</th>
                    <th>Aliases</th><th>Description</th><th>Extractable</th><th>Expert</th><th />
                  </tr>
                </thead>
                <tbody>
                  {types.map((t, i) => (
                    <tr key={i}>
                      <td><Input value={t.name} onChange={(e) => updateType(i, { name: e.target.value })} placeholder="contract" /></td>
                      <td>
                        <Select value={t.primitive} onChange={(e) => updateType(i, { primitive: e.target.value })}>
                          {PRIMITIVES.map((p) => <option key={p} value={p}>{p}</option>)}
                        </Select>
                      </td>
                      <td><Input value={t.folder} onChange={(e) => updateType(i, { folder: e.target.value, folderEdited: true })} placeholder="contracts/" /></td>
                      <td><Input value={t.extraPrefixes} onChange={(e) => updateType(i, { extraPrefixes: e.target.value })} placeholder="legal/contracts/" /></td>
                      <td><Input value={t.aliases} onChange={(e) => updateType(i, { aliases: e.target.value })} placeholder="agreement" /></td>
                      <td><Input value={t.description} onChange={(e) => updateType(i, { description: e.target.value })} /></td>
                      <td><input type="checkbox" checked={t.extractable} onChange={(e) => updateType(i, { extractable: e.target.checked })} /></td>
                      <td><input type="checkbox" checked={t.expertRouting} onChange={(e) => updateType(i, { expertRouting: e.target.checked })} /></td>
                      <td><Button variant="danger" disabled={busy} onClick={() => setTypes((prev) => prev.filter((_, j) => j !== i))}>Remove</Button></td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
            <Button className="mt-2" disabled={busy} onClick={() => setTypes((prev) => [...prev, blankType()])}>Add page type</Button>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-muted">Link verbs</h3>
            <TableWrap>
              <Table>
                <thead><tr><th>Name</th><th>From type</th><th>To type</th><th>Inverse</th><th /></tr></thead>
                <tbody>
                  {verbs.map((v, i) => (
                    <tr key={i}>
                      <td><Input value={v.name} onChange={(e) => setVerbs((prev) => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="governs" /></td>
                      <td><Input value={v.fromType} onChange={(e) => setVerbs((prev) => prev.map((x, j) => (j === i ? { ...x, fromType: e.target.value } : x)))} /></td>
                      <td><Input value={v.toType} onChange={(e) => setVerbs((prev) => prev.map((x, j) => (j === i ? { ...x, toType: e.target.value } : x)))} /></td>
                      <td><Input value={v.inverse} onChange={(e) => setVerbs((prev) => prev.map((x, j) => (j === i ? { ...x, inverse: e.target.value } : x)))} /></td>
                      <td><Button variant="danger" disabled={busy} onClick={() => setVerbs((prev) => prev.filter((_, j) => j !== i))}>Remove</Button></td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
            <Button className="mt-2" disabled={busy} onClick={() => setVerbs((prev) => [...prev, blankVerb()])}>Add link verb</Button>
          </div>

          <Button variant="primary" disabled={busy} onClick={submitDraft}>{busy ? 'Creating…' : 'Create pack'}</Button>
        </div>
      )}

      {tab === 'template' && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-3">
            <Field label="Copy from" id="np-fork-from">
              <Select id="np-fork-from" value={forkFrom} onChange={(e) => setForkFrom(e.target.value)}>
                {packNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </Field>
            <Field label="New pack name" id="np-fork-name">
              <Input id="np-fork-name" value={forkName} onChange={(e) => setForkName(e.target.value)} />
            </Field>
          </div>
          <Button variant="primary" disabled={busy} onClick={submitFork}>{busy ? 'Forking…' : 'Fork pack'}</Button>
        </div>
      )}

      {tab === 'import' && (
        <div className="mt-3 space-y-3">
          <Field label="Draft JSON" id="np-import" hint="A PackDraft from the schema-designer skill. Review it on the Design tab before creating.">
            <Textarea id="np-import" value={importText} onChange={(e) => setImportText(e.target.value)} />
          </Field>
          {importError && <div className="text-[length:var(--control-font)] text-danger">{importError}</div>}
          <Button disabled={busy} onClick={reviewImport}>Review draft</Button>
        </div>
      )}

      {created && <div className="mt-3 text-[length:var(--control-font)] text-ok">Created {created}.</div>}
      {errors.length > 0 && (
        <div className="mt-3 space-y-1">
          {errors.map((e, i) => <div key={i} className="text-[length:var(--control-font)] text-danger">{e}</div>)}
        </div>
      )}
      {gbrainError && <div className="mt-3 text-[length:var(--control-font)] text-danger">{gbrainError}</div>}
      {lint && <LintView lint={lint} />}
    </Card>
  );
}

const toRow = (t: { name: string; primitive: string; pathPrefixes: string[]; aliases: string[]; extractable: boolean; expertRouting: boolean }): EditType => ({
  name: t.name, primitive: t.primitive, pathPrefixes: [...t.pathPrefixes], aliases: [...t.aliases],
  extractable: t.extractable, expertRouting: t.expertRouting,
});

/**
 * Edit one pack's OWN declarations as one atomic mutation batch. Inherited
 * types and verbs are shown read-only, never diffed: gbrain refuses
 * `remove_type` for a type this manifest does not declare (STILL_REFERENCED /
 * NOT_FOUND). A bundled pack renders only its "Fork to edit" fallback, because
 * gbrain refuses mutations to it outright (PACK_READONLY).
 */
export function PackEditor({ name, onSaved }: { name: string; onSaved: () => void }) {
  const [detail, setDetail] = useState<PackDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<EditState | null>(null);
  const [rows, setRows] = useState<EditType[]>([]);
  const [links, setLinks] = useState<EditLink[]>([]);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; code: string | null; failedAtIndex: number | null; packUnchanged: boolean } | null>(null);
  const [saved, setSaved] = useState<PackMutateResult | null>(null);
  const [forkName, setForkName] = useState(`${name}-copy`);
  const [forkError, setForkError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = async () => {
    setLoadError(null);
    try {
      const d = await schemaPacksApi.get(name);
      const ownTypes = new Set(d.own?.pageTypes ?? []);
      const ownVerbs = new Set(d.own?.linkVerbs ?? []);
      const nextRows = d.effective.pageTypes.filter((t) => ownTypes.has(t.name)).map(toRow);
      const nextLinks = d.effective.linkTypes.filter((l) => ownVerbs.has(l.name)).map((l) => ({
        name: l.name, inverse: l.inverse, pageType: l.pageType, targetType: l.targetType,
      }));
      setDetail(d); setRows(nextRows); setLinks(nextLinks); setLoaded({ pageTypes: nextRows, linkTypes: nextLinks });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the pack');
    }
  };
  useEffect(() => { void load(); }, [name]);

  if (loadError) return <Card title={name}><div className="text-[length:var(--control-font)] text-danger">{loadError}</div></Card>;
  if (!detail) return <Card title={name}><Empty>Loading…</Empty></Card>;

  const fork = async () => {
    setBusy(true); setForkError(null);
    try { await schemaPacksApi.create({ mode: 'fork', from: name, name: forkName.trim() }); onSaved(); }
    catch (e) { setForkError(e instanceof Error ? e.message : 'Fork failed'); }
    finally { setBusy(false); }
  };

  if (!detail.editable) {
    return (
      <Card title={`${name} (read-only)`} subtitle={`${name} is a bundled pack; gbrain refuses to mutate it. Fork it to make an editable copy.`}>
        <Field label="New pack name" id="pe-fork">
          <Input id="pe-fork" value={forkName} onChange={(e) => setForkName(e.target.value)} />
        </Field>
        {forkError && <div className="mt-2 text-[length:var(--control-font)] text-danger">{forkError}</div>}
        <div className="mt-3">
          <Button variant="primary" disabled={busy} onClick={fork}>{busy ? 'Forking…' : 'Fork to edit'}</Button>
        </div>
      </Card>
    );
  }

  const updateRow = (i: number, patch: Partial<EditType>) =>
    setRows((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const updateLink = (i: number, patch: Partial<EditLink>) =>
    setLinks((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async () => {
    if (!loaded) return;
    setBusy(true); setSaveError(null); setSaved(null);
    try {
      const mutations = editsToMutations(loaded, { pageTypes: rows, linkTypes: links });
      if (mutations.length === 0) {
        setSaved({ ok: true, batchId: '', applied: 0, error: null, lint: null, scaffolded: [] });
        return;
      }
      const r = await schemaPacksApi.mutate(name, mutations);
      setSaved(r);
      await load();
      onSaved();
    } catch (e) {
      if (e instanceof ApiError) {
        const b = e.body as { error?: unknown; code?: unknown; failedAtIndex?: unknown; packUnchanged?: unknown };
        setSaveError({
          message: typeof b.error === 'string' ? b.error : e.message,
          code: typeof b.code === 'string' ? b.code : null,
          failedAtIndex: typeof b.failedAtIndex === 'number' ? b.failedAtIndex : null,
          packUnchanged: b.packUnchanged === true,
        });
      } else {
        setSaveError({ message: e instanceof Error ? e.message : 'Save failed', code: null, failedAtIndex: null, packUnchanged: false });
      }
    } finally { setBusy(false); }
  };

  const removePack = async () => {
    setBusy(true); setDeleteError(null);
    try { await schemaPacksApi.remove(name); onSaved(); }
    catch (e) { setDeleteError(e instanceof Error ? e.message : 'Delete failed'); }
    finally { setBusy(false); }
  };

  const usedBy = detail.usedBy;
  const deleteDisabled = usedBy.brain || usedBy.sources.length > 0;
  const deleteReason = usedBy.brain
    ? `The brain resolves ${name}; apply another pack before deleting it.`
    : usedBy.sources.length > 0
      ? `Used by ${usedBy.sources.join(', ')}; clear those Space overrides before deleting it.`
      : null;

  const ownTypeNames = new Set(rows.map((r) => r.name));
  const ownVerbNames = new Set(links.map((l) => l.name));
  const inheritedTypes = detail.effective.pageTypes.filter((t) => !ownTypeNames.has(t.name));
  const inheritedLinks = detail.effective.linkTypes.filter((l) => !ownVerbNames.has(l.name));

  return (
    <Card title={name} subtitle={`Editing ${name}'s own declarations. Save sends one atomic batch to gbrain.`}>
      <p className="text-sm text-muted">{ADDITIVE_BUILDER_NOTICE}</p>

      <div className="mt-3">
        <h3 className="text-xs font-semibold text-muted">Page types</h3>
        {rows.length === 0 ? <Empty>This pack declares no page types of its own.</Empty> : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Name</th><th>Primitive</th><th>Folder</th><th>Extra prefixes</th>
                  <th>Aliases</th><th>Extractable</th><th>Expert</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((t, i) => (
                  <tr key={i}>
                    <td>
                      <Input value={t.name} onChange={(e) => updateRow(i, { name: e.target.value })} />
                    </td>
                    <td>
                      <Select value={t.primitive} onChange={(e) => updateRow(i, { primitive: e.target.value })}>
                        {PRIMITIVES.map((p) => <option key={p} value={p}>{p}</option>)}
                      </Select>
                    </td>
                    <td><Input value={t.pathPrefixes[0] ?? ''} onChange={(e) => updateRow(i, { pathPrefixes: [e.target.value, ...t.pathPrefixes.slice(1)] })} /></td>
                    <td><Input value={t.pathPrefixes.slice(1).join(', ')} onChange={(e) => updateRow(i, { pathPrefixes: [t.pathPrefixes[0] ?? '', ...splitList(e.target.value)] })} /></td>
                    <td><Input value={t.aliases.join(', ')} onChange={(e) => updateRow(i, { aliases: splitList(e.target.value) })} /></td>
                    <td><input type="checkbox" checked={t.extractable} onChange={(e) => updateRow(i, { extractable: e.target.checked })} /></td>
                    <td><input type="checkbox" checked={t.expertRouting} onChange={(e) => updateRow(i, { expertRouting: e.target.checked })} /></td>
                    <td><Button variant="danger" disabled={busy} onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}>Remove</Button></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
        <Button className="mt-2" disabled={busy} onClick={() => setRows((prev) => [...prev, toRow({ name: '', primitive: 'entity', pathPrefixes: [''], aliases: [], extractable: false, expertRouting: false })])}>Add page type</Button>
      </div>

      <div className="mt-4">
        <h3 className="text-xs font-semibold text-muted">Link verbs</h3>
        {links.length === 0 ? <Empty>This pack declares no link verbs of its own.</Empty> : (
          <TableWrap>
            <Table>
              <thead><tr><th>Name</th><th>From type</th><th>To type</th><th>Inverse</th><th /></tr></thead>
              <tbody>
                {links.map((l, i) => (
                  <tr key={i}>
                    <td><Input value={l.name} onChange={(e) => updateLink(i, { name: e.target.value })} /></td>
                    <td><Input value={l.pageType ?? ''} onChange={(e) => updateLink(i, { pageType: e.target.value || null })} /></td>
                    <td><Input value={l.targetType ?? ''} onChange={(e) => updateLink(i, { targetType: e.target.value || null })} /></td>
                    <td><Input value={l.inverse ?? ''} onChange={(e) => updateLink(i, { inverse: e.target.value || null })} /></td>
                    <td><Button variant="danger" disabled={busy} onClick={() => setLinks((prev) => prev.filter((_, j) => j !== i))}>Remove</Button></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
        <Button className="mt-2" disabled={busy} onClick={() => setLinks((prev) => [...prev, { name: '', inverse: null, pageType: null, targetType: null }])}>Add link verb</Button>
      </div>

      {(inheritedTypes.length > 0 || inheritedLinks.length > 0) && detail.effective.extends && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold text-muted">Inherited</h3>
          {inheritedTypes.length > 0 && (
            <TableWrap>
              <Table>
                <thead><tr><th>Name</th><th>Primitive</th><th>Folder</th></tr></thead>
                <tbody>
                  {inheritedTypes.map((t) => (
                    <tr key={t.name}>
                      <td><code>{t.name}</code> <Badge tone="neutral">from {detail.effective.extends}</Badge></td>
                      <td>{t.primitive}</td>
                      <td>{t.pathPrefixes.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
          {inheritedLinks.length > 0 && (
            <p className="mt-2 text-[length:var(--control-font)] text-muted">
              Inherited verbs: {inheritedLinks.map((l) => l.name).join(' · ')}
            </p>
          )}
        </div>
      )}

      <div className="mt-4">
        <Button variant="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>

      {saveError && (
        <div className="mt-3 text-[length:var(--control-font)] text-danger">
          {saveError.message}
          {saveError.code ? ` (${saveError.code})` : ''}
          {saveError.failedAtIndex !== null ? ` — row ${saveError.failedAtIndex}` : ''}
          {saveError.packUnchanged ? '. Nothing was changed.' : ''}
        </div>
      )}
      {saved && (
        <div className="mt-3 space-y-2">
          <div className="text-[length:var(--control-font)] text-ok">
            Saved — {saved.applied} change{saved.applied === 1 ? '' : 's'} applied.
          </div>
          {saved.scaffolded.length > 0 && <ScaffoldResults results={saved.scaffolded} />}
        </div>
      )}

      <div className="mt-6 border-t border-border pt-4">
        <h3 className="text-xs font-semibold text-muted">Delete</h3>
        {deleteReason && <p className="text-[length:var(--control-font)] text-muted">{deleteReason}</p>}
        {deleteError && <div className="text-[length:var(--control-font)] text-danger">{deleteError}</div>}
        <Button className="mt-2" variant="danger" disabled={busy || deleteDisabled} onClick={removePack}>Delete pack</Button>
      </div>
    </Card>
  );
}
