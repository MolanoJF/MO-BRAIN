import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { api, sourcesApi, type PackCreateResult } from '../api.ts';
import { RemotePanel } from '../RemotePanel.tsx';
import { MEASURED_COST_DISCLAIMER } from '../../control/lifecycle.ts';
import { Button, Empty, Icon, Input, Notice, PageTitle } from '../ui/index.tsx';
import { NewPackPanel } from './SchemaBuilder.tsx';

/**
 * The two pickers on this page (search mode, schema pack) are `<button>`s that
 * were wearing `.card`. `Card` is a `<section>` and cannot become one, and
 * `ui/` has no selectable-card primitive — so the box is spelled out from the
 * same tokens `Card` uses. It is NOT `Card`'s padding: `.card` was `12px` and
 * `Card` is `18px / 24px`, and a wizard step that stacks four of these would
 * grow by most of a screen. Flagged in the report as the missing primitive.
 */
const PICKER_CARD =
  'w-full text-left p-3 rounded-[var(--radius)] border border-border bg-surface ' +
  'enabled:hover:bg-subtle disabled:opacity-45 disabled:cursor-not-allowed';

type SearchMode = {
  id: string; label: string; relativeCost: number;
  measuredCost: number | null; measuredAt: string | null; measuredOn: string | null;
  description: string;
};
type ScaffoldReport = { sourceId: string; created: string[]; error: string | null }[];

/** Folder problems from `/wizard/finish`, as sentences. Empty when every Space was scaffolded. */
export function scaffoldProblems(scaffold: ScaffoldReport | undefined): string[] {
  return (scaffold ?? []).filter((r) => r.error !== null)
    .map((r) => `${r.sourceId === '*' ? 'Your Sources' : r.sourceId}: ${r.error}`);
}

type State = {
  lifecycle: string; nextStep: string | null; searchModes: SearchMode[];
  spaces: { sourceId: string; name: string; gitRemote: string | null }[]; isolationNotice: string;
};

export function Wizard({ onReady }: { onReady: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [folderProblems, setFolderProblems] = useState<string[]>([]);

  const load = async () => setState(await api.get<State>('/wizard/state'));
  useEffect(() => { void load(); }, []);

  const step = async (path: string, body: unknown) => {
    setBusy(true); setError(null);
    try { await api.post(path, body); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Step failed'); }
    finally { setBusy(false); }
  };

  if (!state) return <Empty>Loading…</Empty>;

  const modes = state.searchModes;
  const measured = modes.filter((m) => m.measuredCost !== null);

  return (
    <div className="max-w-2xl space-y-8">
      <header>
        <PageTitle>Set up your personal brain</PageTitle>
        <p className="text-sm text-muted">Stage: <span className="font-mono">{state.lifecycle}</span></p>
      </header>

      {error && (
        <Notice tone="danger">
          <Icon glyph={CircleAlert} size={16} />
          <span>{error}</span>
        </Notice>
      )}

      {state.nextStep === 'provider-configured' && (
        <ProviderStep busy={busy} onSubmit={(b) => step('/wizard/provider', b)} />
      )}

      {state.nextStep === 'mode-selected' && (
        <section className="space-y-3">
          <h2 className="font-medium">Choose a search mode</h2>
          {/* `text-neutral-600` / `text-neutral-500` were raw Tailwind palette
              greys, not tokens — they are baked literals that do not re-paint
              under `:root.dark`, so both of these paragraphs were grey-on-grey
              and close to unreadable on the dark console. Both collapse onto
              `text-muted`, which is the only "secondary copy" token the system
              has; the disclaimer loses its extra half-step of quiet, and that
              is the right trade against a sentence nobody could read. */}
          {measured.length === modes.length ? (
            <p className="text-sm text-muted">
              On this deployment, the most expensive mode costs about{' '}
              {Math.max(...measured.map((m) => m.measuredCost!))}× the cheapest.{' '}
              <span className="text-muted">{MEASURED_COST_DISCLAIMER}</span>
            </p>
          ) : (
            <p className="text-sm text-muted">
              Not measured on this deployment. Upstream reports roughly{' '}
              {Math.max(...modes.map((m) => m.relativeCost))}× between the cheapest and most
              expensive mode; your own spread will differ. The Spend page shows what you
              actually pay once the brain has run for a few days.
            </p>
          )}
          {modes.map((m) => (
            <button key={m.id} type="button" className={PICKER_CARD} disabled={busy}
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
        <SchemaStep busy={busy} onSubmit={(pack) => step('/wizard/schema', { pack })} onDone={load} />
      )}

      {state.nextStep === 'sources-added' && (
        <SpaceStep busy={busy} onSubmit={() => step('/wizard/private-space', {})} />
      )}

      {folderProblems.length > 0 && (
        <Notice tone="warning" layout="stack">
          <p className="font-medium">Your brain is ready, but its folders were not created.</p>
          {folderProblems.map((p) => <p key={p} className="text-sm font-mono">{p}</p>)}
          <p className="text-sm">Open Schema and choose Create folders to retry. Nothing else is affected.</p>
          <Button variant="primary" onClick={onReady}>Continue</Button>
        </Notice>
      )}

      {state.nextStep === 'ready' && state.spaces[0] && (
        <section className="space-y-3">
          <h2 className="font-medium">Keep a copy off this server (optional)</h2>
          <p className="text-sm text-muted">
            Your Source is a git repository on this server. Connect it to a GitHub repo now, or skip
            this and do it later from My brain. Nothing is pushed until setup finishes; then use
            Push now on My brain.
          </p>
          <RemotePanel
            sourceId={state.spaces[0].sourceId}
            gitRemote={state.spaces[0].gitRemote}
            busy={busy}
            pushOnConnect={false}
            api={{
              set: (body) => sourcesApi.setRemote(state.spaces[0]!.sourceId, body),
              push: () => sourcesApi.pushRemote(state.spaces[0]!.sourceId),
              clear: () => sourcesApi.clearRemote(state.spaces[0]!.sourceId),
            }}
            onChanged={load}
          />
        </section>
      )}

      {state.nextStep === 'ready' && (
        <section className="space-y-3">
          <h2 className="font-medium">Finish setup</h2>
          <p className="text-sm text-muted">
            Initializes the brain, applies your search mode, imports and embeds your Source,
            then runs a health check. This takes several minutes.
          </p>
          <Button variant="primary" disabled={busy}
                  onClick={async () => {
                    setBusy(true); setError(null);
                    try {
                      const r = await api.post<{ scaffold?: ScaffoldReport }>('/wizard/finish', {});
                      const problems = scaffoldProblems(r.scaffold);
                      // The brain is ready either way; folders are the one thing worth
                      // stopping to say, because nothing else would.
                      if (problems.length > 0) { setFolderProblems(problems); await load(); return; }
                      await load(); onReady();
                    } catch (e) { setError(e instanceof Error ? e.message : 'Step failed'); }
                    finally { setBusy(false); }
                  }}>
            {busy ? 'Running…' : 'Finish setup'}
          </Button>
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
      <Input className="font-mono" type="password" placeholder="sk-…"
             value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      <Button variant="primary" disabled={busy || !apiKey}
              onClick={() => onSubmit({
                provider: 'openai', apiKey,
                embeddingModel: 'openai:text-embedding-3-small',
              })}>
        {busy ? 'Saving…' : 'Save key'}
      </Button>
    </section>
  );
}

function SchemaStep({ busy, onSubmit, onDone }: {
  busy: boolean; onSubmit: (pack: string) => void; onDone: () => void;
}) {
  const [packs, setPacks] = useState<string[]>([]);
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    void api.get<{ packs: string[] }>('/wizard/schema-packs')
      .then((r) => setPacks(r.packs ?? []))
      .catch(() => setPacks(['gbrain-base-v2']));
  }, []);
  return (
    <section className="space-y-3">
      <h2 className="font-medium">Pick a shape for your knowledge</h2>
      <p className="text-sm text-muted">
        A schema pack decides what kinds of pages your brain recognizes. Start with the default —
        under 20 pages of a kind, don't codify it.
      </p>
      {packs.map((id) => (
        <button key={id} type="button" className={PICKER_CARD} disabled={busy}
                onClick={() => onSubmit(id)}>
          <span className="font-mono">{id}</span>
        </button>
      ))}
      {/* Branch A (S7 probe 7): gbrain's validate / lint / show all answer with
          no DB, so a pack the admin designs can be written and linted BEFORE
          `init`, then stored and applied by /finish like any template pick. */}
      {!custom ? (
        <Button disabled={busy} onClick={() => setCustom(true)}>Design our own</Button>
      ) : (
        <NewPackPanel
          parent="gbrain-base-v2"
          packs={packs.map((name) => ({ name }))}
          onCreated={onDone}
          createDraft={(draft) => api.post<PackCreateResult>('/wizard/schema', { draft })}
        />
      )}
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
      <h2 className="font-medium">Create your private Source</h2>
      <p className="text-sm text-muted">
        This is your private Source — only you can access it. You can add shared Sources
        and invite members later.
      </p>
      <Button variant="primary" disabled={busy} onClick={() => onSubmit()}>
        {busy ? 'Creating…' : 'Continue'}
      </Button>
    </section>
  );
}
