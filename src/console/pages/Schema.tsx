import { useEffect, useState } from 'react';
import {
  api, schemaPacksApi,
  type PackDetail, type PackPageType, type ScaffoldResult, type SchemaSync,
} from '../api.ts';
import { Badge, Button, Card, Empty, Table, TableWrap } from '../ui/index.tsx';
import { NewPackPanel, PackEditor, ScaffoldResults } from './SchemaBuilder.tsx';

type Active = {
  pack: string | null; version: string | null; source: string | null;
  identity: string | null; pageTypes: number | null; linkVerbs: number | null;
};
type State = { stored: string | null; active: Active; packs: string[]; diverged: boolean };
type LintRule = { rule: string; message: string; hint?: string };
type Lint = { ok: boolean; errors: LintRule[]; warnings: LintRule[] };
type Sync = SchemaSync;

/**
 * A pack switch is additive: `gbrain schema sync` only fills a blank `type`,
 * so pages typed under the old pack keep their old type. Saying so is the
 * single most important thing this page does — an admin who expects a switch
 * to reclassify the corpus will otherwise read "0 applied" as a failure.
 */
export const ADDITIVE_NOTICE =
  'Switching packs does not re-type existing pages. Sync only fills in pages that have no type yet — ' +
  'already-typed pages keep the type they were given under the previous pack.';

/**
 * The decision logic below is exported as pure functions because that is how
 * this console is tested (see test/unit/console-upgrades.test.ts): no DOM, no
 * render harness — the component arranges these and nothing more.
 */
export function activeSummary(active: Active): string {
  if (!active.pack) return 'Could not resolve an active pack.';
  const v = active.version ? ` v${active.version}` : '';
  return `${active.pack}${v} — resolved from ${active.source ?? 'an unknown source'}`;
}

/** Null when there is nothing to warn about. Never rounds a mismatch up. */
export function divergenceWarning(s: { stored: string | null; active: Active; diverged: boolean }): string | null {
  if (!s.diverged || !s.stored) return null;
  return (
    `This brain is set to ${s.stored} here, but gbrain resolves ` +
    `${s.active.pack ?? 'no pack'} from the ${s.active.source} tier, which outranks the ` +
    `setting this page writes. Clear that source for the choice to take effect.`
  );
}

/**
 * Apply needs a clean lint AND a seen preview. Warnings do not block —
 * gbrain-base-v2 itself lints with warnings, so blocking on those would make
 * the shipped default unselectable.
 */
export function canApply(s: { busy: boolean; pack: string; lint: Lint | null; preview: Sync | null }): boolean {
  return !s.busy && s.pack !== '' && s.preview !== null && s.lint !== null && s.lint.ok;
}

export function syncSummary(report: Sync): string {
  const live = report.per_prefix.filter((p) => !p.dead_prefix);
  if (live.length === 0) {
    return (
      "No untyped pages match this pack's prefixes. That is the normal result on a brain whose " +
      'pages are already typed — it does not mean the pack is wrong.'
    );
  }
  return `${report.total_would_apply} page(s) would be typed · ${report.total_applied} applied`;
}

/**
 * One pack's EFFECTIVE counts, as the row renders them. The counts come from
 * `/api/schema/packs`, which routes through gbrain's own resolver: `gbrain-creator`
 * reports 27 effective page types from a manifest that declares 1. Reading the
 * raw manifest here would be the false claim Task 1's `packOverride` seam exists
 * to prevent (MEASURED, docs/schema-pack-findings.md S4).
 */
export function packSummary(detail: PackDetail): string {
  const types = `${detail.pageTypes.length} page type${detail.pageTypes.length === 1 ? '' : 's'}`;
  const verbs = `${detail.linkVerbs.length} link verb${detail.linkVerbs.length === 1 ? '' : 's'}`;
  const base = `${types} · ${verbs}`;
  return detail.extends ? `${base} · extends ${detail.extends}` : base;
}

/** One page type's label: `thesis (concept) — investing/theses/, theses/`. */
export function pageTypeLabel(pageType: PackPageType): string {
  const primitive = pageType.primitive ? ` (${pageType.primitive})` : '';
  const prefixes = pageType.pathPrefixes.length > 0 ? ` — ${pageType.pathPrefixes.join(', ')}` : '';
  return `${pageType.name}${primitive}${prefixes}`;
}

/**
 * The inherited-vs-override sentence. `inherited` means no per-Space override
 * is set, so the brain-wide pack applies. An override returns null: the caller
 * names it as the STORED intent, never as a resolved state (S6 Gate 2 — gbrain
 * offers no per-Space readback at this pin).
 */
export function inheritanceNote(inherited: boolean, pack: string | null): string | null {
  if (!inherited) return null;
  return `Inherits the brain default${pack ? ` (${pack})` : ''}.`;
}

export function Schema() {
  const [state, setState] = useState<State | null>(null);
  const [details, setDetails] = useState<PackDetail[]>([]);
  const [packsError, setPacksError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pack, setPack] = useState('');
  const [lint, setLint] = useState<Lint | null>(null);
  const [preview, setPreview] = useState<Sync | null>(null);
  const [applied, setApplied] = useState<Sync | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [builder, setBuilder] = useState<{ mode: 'new' } | { mode: 'edit'; name: string } | null>(null);
  const [scaffold, setScaffold] = useState<ScaffoldResult[] | null>(null);

  const load = async () => {
    const s = await api.get<State>('/schema');
    setState(s);
    setPack((current) => current || s.stored || s.active.pack || '');
  };
  const loadPacks = () => schemaPacksApi.list()
    .then((body) => { setDetails(body.packs); setPacksError(null); })
    .catch((e) => setPacksError(e instanceof Error ? e.message : 'The pack list could not be loaded.'));
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : 'Load failed'));
    void loadPacks();
  }, []);

  const step = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Step failed'); }
    finally { setBusy(false); }
  };

  // Any change to the candidate invalidates the gate: a preview of the old
  // pack must never authorize applying a different one.
  const choose = (name: string) => { setPack(name); setLint(null); setPreview(null); setApplied(null); };

  // Expanding a pack makes it the candidate and invalidates the gate. Collapsing
  // leaves the candidate alone — the controls are only rendered while expanded.
  const toggle = (name: string) => {
    if (expanded === name) { setExpanded(null); return; }
    setExpanded(name);
    choose(name);
  };

  const runLint = () => step(async () => setLint(await api.post<Lint>('/schema/lint', { pack, withDb: true })));
  const runPreview = () => step(async () => setPreview(await api.post<Sync>('/schema/preview', {})));
  const runApply = () => step(async () => {
    await api.post('/schema/apply', { pack });
    setPreview(null);
    await load();
  });
  const runSync = () => step(async () => { setApplied(await api.post<Sync>('/schema/sync', {})); await load(); });
  const runScaffold = () => step(async () => setScaffold((await schemaPacksApi.scaffold()).results));

  if (!state) return <Empty>Loading…</Empty>;

  const changing = pack !== state.active.pack;
  // Preview before apply. A pack change is cheap to reverse but expensive to
  // explain, and the preview is where "0 would apply" gets seen up front.
  const applyEnabled = canApply({ busy, pack, lint, preview });
  const warning = divergenceWarning(state);

  return (
    <div className="max-w-3xl space-y-8">
      <header>
        <h1 className="text-xl font-semibold">Schema</h1>
        <p className="text-sm text-muted">
          The schema pack decides what kinds of pages the brain recognizes.
        </p>
      </header>

      {error && <div className="text-[length:var(--control-font)] text-danger">{error}</div>}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Active</h2>
        <div className="text-sm">
          <div>{activeSummary(state.active)}</div>
          {state.active.identity && <div><span className="text-muted">Identity:</span> <code>{state.active.identity}</code></div>}
          {state.active.pageTypes !== null && (
            <div><span className="text-muted">Page types:</span> {state.active.pageTypes} · <span className="text-muted">Link verbs:</span> {state.active.linkVerbs}</div>
          )}
        </div>
        {warning && (
          // Never round this up to a checkmark: the brain is running a pack
          // nobody here chose, because a higher-priority tier outranks ours.
          <div className="text-[length:var(--control-font)] text-danger">{warning}</div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Schema packs</h2>
          <Button disabled={busy} onClick={() => setBuilder({ mode: 'new' })}>New pack</Button>
        </div>
        <p className="text-sm text-muted">{ADDITIVE_NOTICE}</p>

        {builder?.mode === 'new' && (
          <NewPackPanel
            parent={state.active.pack}
            packs={details}
            onCreated={() => { setBuilder(null); void loadPacks(); }}
          />
        )}
        {builder?.mode === 'edit' && (
          <PackEditor name={builder.name} onSaved={() => { void loadPacks(); }} />
        )}

        {packsError && <div className="text-[length:var(--control-font)] text-danger">{packsError}</div>}
        {!packsError && details.length === 0 && <Empty>Loading packs…</Empty>}
        {details.map((d) => {
          const isActive = d.name === state.active.pack;
          const isOpen = expanded === d.name;
          return (
            <Card key={d.name} className="space-y-2">
              {/* A disclosure row: the pack's name on the left, its ACTIVE badge
                  on the right. `layout="between"` is the button's own
                  justify-content rather than a `justify-between` passed through
                  `className`, so there is only ever one such utility and no
                  emit order to lose to. The inner `<span>` that used to carry
                  the layout is gone with it. */}
              <Button className="w-full" layout="between" disabled={busy} onClick={() => toggle(d.name)}>
                <span className="font-mono">{isOpen ? '▾' : '▸'} {d.name}</span>
                {isActive && (
                  <Badge tone="ok">
                    {state.active.source ? `ACTIVE (${state.active.source})` : 'ACTIVE'}
                  </Badge>
                )}
              </Button>
              {d.error
                ? <div className="text-[length:var(--control-font)] text-danger">{d.error}</div>
                : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[length:var(--control-font)] text-muted">{packSummary(d)}</div>
                    <Button disabled={busy} onClick={() => setBuilder({ mode: 'edit', name: d.name })}>
                      {d.bundled ? 'Fork to edit' : 'Edit'}
                    </Button>
                  </div>
                )}
              {isOpen && d.error === null && (
                <div className="space-y-3 pt-2">
                  <PackTypesView detail={d} />
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy || pack === ''} onClick={runLint}>Lint</Button>
                    <Button disabled={busy} onClick={runPreview}>Preview sync</Button>
                    <Button variant="primary" disabled={!applyEnabled} onClick={runApply}>
                      {changing ? `Apply ${pack}` : 'Apply'}
                    </Button>
                  </div>
                  {!applyEnabled && pack !== '' && (
                    <p className="text-xs text-muted">Lint clean and a sync preview are both required before applying.</p>
                  )}
                  {lint && <LintReport lint={lint} />}
                  {preview && <SyncTable title="Preview — nothing written" report={preview} />}
                </div>
              )}
            </Card>
          );
        })}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Backfill types</h2>
        <p className="text-sm text-muted">
          Fills in pages that have no type yet, using the active pack's path prefixes. {ADDITIVE_NOTICE}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} onClick={runSync}>Run sync</Button>
          <Button disabled={busy} onClick={runScaffold}>Create folders</Button>
        </div>
        {scaffold && <ScaffoldResults results={scaffold} />}
        {applied && <SyncTable title={`Applied — ${applied.total_applied} page(s) typed`} report={applied} />}
      </section>
    </div>
  );
}

/**
 * A pack's resolved page types and link verbs, or its error. EXACTLY one of
 * those is ever rendered: a pack that failed to resolve shows the error, never
 * an empty type list that reads as "this pack brings nothing".
 *
 * Exported so the Sources page renders a per-Space pack the same way — one
 * implementation, not two.
 */
export function PackTypesView({ detail }: { detail: PackDetail }) {
  if (detail.error !== null) return <div className="text-[length:var(--control-font)] text-danger">{detail.error}</div>;
  return (
    <div className="space-y-3">
      {detail.description && <p className="text-sm text-muted">{detail.description}</p>}
      <div>
        <h3 className="text-xs font-semibold text-muted">Page types</h3>
        {detail.pageTypes.length === 0 ? (
          <Empty>This pack declares no page types.</Empty>
        ) : (
          <ul className="text-sm">
            {detail.pageTypes.map((p) => (
              <li key={p.name}><code>{pageTypeLabel(p)}</code></li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="text-xs font-semibold text-muted">Link verbs</h3>
        {detail.linkVerbs.length === 0 ? (
          <Empty>This pack declares no link verbs.</Empty>
        ) : (
          <p className="text-sm">{detail.linkVerbs.join(' · ')}</p>
        )}
      </div>
    </div>
  );
}

function LintReport({ lint }: { lint: Lint }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">Lint — {lint.ok ? 'clean' : 'errors'}</h2>
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
      {lint.ok && lint.warnings.length === 0 && <Empty>No findings.</Empty>}
    </section>
  );
}

/** Exported so the Sources page reuses the same summary and table. */
export function SyncTable({ title, report }: { title: string; report: Sync }) {
  const live = report.per_prefix.filter((p) => !p.dead_prefix);
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="text-[length:var(--control-font)] text-muted">
        {syncSummary(report)}
        {report.pack_identity ? ` · ${report.pack_identity}` : ''}
      </div>
      {live.length > 0 && (
        <TableWrap>
          {/* Two labels, then two counts. */}
          <Table align={['left', 'left', 'right', 'right']}>
            <thead>
              <tr>
                <th>Type</th>
                <th>Prefix</th>
                <th>Would apply</th>
                <th>Applied</th>
              </tr>
            </thead>
            <tbody>
              {live.map((p) => (
                <tr key={`${p.type}:${p.prefix}`}>
                  <td><code>{p.type}</code></td>
                  <td><code>{p.prefix}</code></td>
                  <td>{p.would_apply}</td>
                  <td>{p.applied}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </section>
  );
}
