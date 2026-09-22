import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { MEASURED_COST_DISCLAIMER } from '../../control/lifecycle.ts';

type SearchMode = {
  id: string; label: string; relativeCost: number;
  measuredCost: number | null; measuredAt: string | null; measuredOn: string | null;
  description: string;
};
type State = {
  lifecycle: string; nextStep: string | null; searchModes: SearchMode[];
  spaces: { sourceId: string; name: string }[]; isolationNotice: string;
};

export function Wizard({ onReady }: { onReady: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => setState(await api.get<State>('/wizard/state'));
  useEffect(() => { void load(); }, []);

  const step = async (path: string, body: unknown) => {
    setBusy(true); setError(null);
    try { await api.post(path, body); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Step failed'); }
    finally { setBusy(false); }
  };

  if (!state) return <div className="text-muted">Loading…</div>;

  const modes = state.searchModes;
  const measured = modes.filter((m) => m.measuredCost !== null);

  return (
    <div className="max-w-2xl space-y-8">
      <header>
        <h1 className="text-xl font-semibold">Set up your brain</h1>
        <p className="text-sm text-muted">Stage: <span className="font-mono">{state.lifecycle}</span></p>
      </header>

      {error && <div className="text-danger text-sm">{error}</div>}

      {state.nextStep === 'provider-configured' && (
        <ProviderStep busy={busy} onSubmit={(b) => step('/wizard/provider', b)} />
      )}

      {state.nextStep === 'mode-selected' && (
        <section className="space-y-3">
          <h2 className="font-medium">Choose a search mode</h2>
          {measured.length === modes.length ? (
            <p className="text-sm text-neutral-600">
              On this deployment, the most expensive mode costs about{' '}
              {Math.max(...measured.map((m) => m.measuredCost!))}× the cheapest.{' '}
              <span className="text-neutral-500">{MEASURED_COST_DISCLAIMER}</span>
            </p>
          ) : (
            <p className="text-sm text-neutral-600">
              Not measured on this deployment. Upstream reports roughly{' '}
              {Math.max(...modes.map((m) => m.relativeCost))}× between the cheapest and most
              expensive mode; your own spread will differ. The Spend page shows what you
              actually pay once the brain has run for a few days.
            </p>
          )}
          {modes.map((m) => (
            <button key={m.id} className="card w-full text-left" disabled={busy}
                    onClick={() => step('/wizard/search-mode', { mode: m.id })}>
              <div className="flex justify-between">
                <span className="font-medium">{m.label}</span>
                <span className="font-mono text-sm text-muted">{m.relativeCost}× cost</span>
              </div>
              <p className="text-sm text-muted">{m.description}</p>
            </button>
          ))}
        </section>
      )}

      {state.nextStep === 'schema-selected' && (
        <SchemaStep busy={busy} onSubmit={(pack) => step('/wizard/schema', { pack })} />
      )}

      {state.nextStep === 'sources-added' && (
        <SpaceStep busy={busy} onSubmit={() => step('/wizard/private-space', {})} />
      )}

      {state.nextStep === 'ready' && (
        <section className="space-y-3">
          <h2 className="font-medium">Finish setup</h2>
          <p className="text-sm text-muted">
            Initializes the brain, applies your search mode, imports and embeds your Space,
            then runs a health check. This takes several minutes.
          </p>
          <button className="btn-primary" disabled={busy}
                  onClick={async () => { await step('/wizard/finish', {}); onReady(); }}>
            {busy ? 'Running…' : 'Finish setup'}
          </button>
        </section>
      )}
    </div>
  );
}

function ProviderStep({ busy, onSubmit }: { busy: boolean; onSubmit: (b: unknown) => void }) {
  const [apiKey, setApiKey] = useState('');
  return (
    <section className="space-y-3">
      <h2 className="font-medium">Connect a model provider</h2>
      <p className="text-sm text-muted">
        Stored encrypted. It is written to the brain's config file, never to its database.
      </p>
      <input className="field font-mono" type="password" placeholder="sk-…"
             value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      <button className="btn-primary" disabled={busy || !apiKey}
              onClick={() => onSubmit({
                provider: 'openai', apiKey,
                embeddingModel: 'openai:text-embedding-3-small',
              })}>
        {busy ? 'Saving…' : 'Save key'}
      </button>
    </section>
  );
}

function SchemaStep({ busy, onSubmit }: { busy: boolean; onSubmit: (pack: string) => void }) {
  const [packs, setPacks] = useState<{ id?: string; name?: string }[]>([]);
  useEffect(() => {
    void api.get<{ packs: { id?: string; name?: string }[] }>('/wizard/schema-packs')
      .then((r) => setPacks(r.packs ?? []))
      .catch(() => setPacks([{ id: 'gbrain-base-v2', name: 'gbrain-base-v2' }]));
  }, []);
  return (
    <section className="space-y-3">
      <h2 className="font-medium">Pick a shape for your knowledge</h2>
      <p className="text-sm text-muted">
        A schema pack decides what kinds of pages your brain recognizes. Start with the default —
        under 20 pages of a kind, don't codify it.
      </p>
      {packs.map((p) => {
        const id = p.id ?? p.name ?? 'gbrain-base-v2';
        return (
          <button key={id} className="card w-full text-left" disabled={busy}
                  onClick={() => onSubmit(id)}>
            <span className="font-mono">{id}</span>
          </button>
        );
      })}
    </section>
  );
}

/**
 * A brand-new brain starts with exactly one source: the signed-in member's own
 * private space. There is no naming decision to make and nothing to consent to
 * beyond what a private space already means.
 */
function SpaceStep({ busy, onSubmit }: { busy: boolean; onSubmit: () => void }) {
  return (
    <section className="space-y-3">
      <h2 className="font-medium">Create your private space</h2>
      <p className="text-sm text-muted">
        This is your private space — only you can access it. You can add shared Spaces
        and invite members later.
      </p>
      <button className="btn-primary" disabled={busy} onClick={() => onSubmit()}>
        {busy ? 'Creating…' : 'Continue'}
      </button>
    </section>
  );
}
