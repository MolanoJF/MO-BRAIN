import { useEffect, useState } from 'react';
import { api } from '../api.ts';

type Active = {
  pack: string | null; version: string | null; source: string | null;
  identity: string | null; pageTypes: number | null; linkVerbs: number | null;
};
type State = { stored: string | null; active: Active; packs: string[]; diverged: boolean };
type LintRule = { rule: string; message: string; hint?: string };
type Lint = { ok: boolean; errors: LintRule[]; warnings: LintRule[] };
type PerPrefix = { type: string; prefix: string; would_apply: number; applied: number; dead_prefix: boolean; sample_slugs: string[] };
type Sync = { apply: boolean; pack_identity: string | null; per_prefix: PerPrefix[]; total_would_apply: number; total_applied: number };

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

export function Schema() {
  const [state, setState] = useState<State | null>(null);
  const [pack, setPack] = useState('');
  const [lint, setLint] = useState<Lint | null>(null);
  const [preview, setPreview] = useState<Sync | null>(null);
  const [applied, setApplied] = useState<Sync | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const s = await api.get<State>('/schema');
    setState(s);
    setPack((current) => current || s.stored || s.active.pack || '');
  };
  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : 'Load failed')); }, []);

  const step = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Step failed'); }
    finally { setBusy(false); }
  };

  // Any change to the candidate invalidates the gate: a preview of the old
  // pack must never authorize applying a different one.
  const choose = (name: string) => { setPack(name); setLint(null); setPreview(null); setApplied(null); };

  const runLint = () => step(async () => setLint(await api.post<Lint>('/schema/lint', { pack, withDb: true })));
  const runPreview = () => step(async () => setPreview(await api.post<Sync>('/schema/preview', {})));
  const runApply = () => step(async () => {
    await api.post('/schema/apply', { pack });
    setPreview(null);
    await load();
  });
  const runSync = () => step(async () => { setApplied(await api.post<Sync>('/schema/sync', {})); await load(); });

  if (!state) return <div className="text-muted">Loading…</div>;

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

      {error && <div className="text-danger text-sm">{error}</div>}

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
          <div className="text-danger text-sm">{warning}</div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Change pack</h2>
        <p className="text-sm text-muted">{ADDITIVE_NOTICE}</p>
        <select
          className="w-full" value={pack} disabled={busy}
          onChange={(e) => choose(e.currentTarget.value)}
        >
          {state.packs.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        <div className="flex gap-2">
          <button disabled={busy || pack === ''} onClick={runLint}>Lint</button>
          <button disabled={busy} onClick={runPreview}>Preview sync</button>
          <button disabled={!applyEnabled} onClick={runApply}>
            {changing ? `Apply ${pack}` : 'Apply'}
          </button>
        </div>
        {!applyEnabled && pack !== '' && (
          <p className="text-xs text-muted">Lint clean and a sync preview are both required before applying.</p>
        )}
      </section>

      {lint && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Lint — {lint.ok ? 'clean' : 'errors'}</h2>
          {lint.errors.map((e, i) => (
            <div key={`e${i}`} className="text-danger text-sm">
              <code>{e.rule}</code>: {e.message}{e.hint ? ` — ${e.hint}` : ''}
            </div>
          ))}
          {lint.warnings.map((w, i) => (
            <div key={`w${i}`} className="text-muted text-sm">
              <code>{w.rule}</code>: {w.message}{w.hint ? ` — ${w.hint}` : ''}
            </div>
          ))}
          {lint.ok && lint.warnings.length === 0 && <div className="text-sm text-muted">No findings.</div>}
        </section>
      )}

      {preview && <SyncTable title="Preview — nothing written" report={preview} />}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Backfill types</h2>
        <p className="text-sm text-muted">
          Fills in pages that have no type yet, using the active pack's path prefixes. {ADDITIVE_NOTICE}
        </p>
        <button disabled={busy} onClick={runSync}>Run sync</button>
        {applied && <SyncTable title={`Applied — ${applied.total_applied} page(s) typed`} report={applied} />}
      </section>
    </div>
  );
}

function SyncTable({ title, report }: { title: string; report: Sync }) {
  const live = report.per_prefix.filter((p) => !p.dead_prefix);
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="text-sm text-muted">
        {syncSummary(report)}
        {report.pack_identity ? ` · ${report.pack_identity}` : ''}
      </div>
      {live.length > 0 && (
        <table className="w-full text-sm">
          <thead><tr><th className="text-left">Type</th><th className="text-left">Prefix</th><th className="text-right">Would apply</th><th className="text-right">Applied</th></tr></thead>
          <tbody>
            {live.map((p) => (
              <tr key={`${p.type}:${p.prefix}`}>
                <td><code>{p.type}</code></td>
                <td><code>{p.prefix}</code></td>
                <td className="text-right">{p.would_apply}</td>
                <td className="text-right">{p.applied}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
