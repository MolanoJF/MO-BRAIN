import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { api, ApiError, sessionApi } from '../api.ts';
import { Button, Empty, Icon, Input, Notice, Spinner } from '../ui/index.tsx';
import { OnboardingCard } from '../onboarding/OnboardingCard.tsx';

type ScaffoldReport = { sourceId: string; created: string[]; error: string | null }[];

/** Folder problems from `/wizard/finish`, as sentences. Empty when every Space was scaffolded. */
export function scaffoldProblems(scaffold: ScaffoldReport | undefined): string[] {
  return (scaffold ?? []).filter((r) => r.error !== null)
    .map((r) => `${r.sourceId === '*' ? 'Your Sources' : r.sourceId}: ${r.error}`);
}

type State = { lifecycle: string };

/** Steps 2 and 3 of onboarding. The view is chosen by the stored lifecycle. */
export function Wizard({ onReady }: { onReady: () => void }) {
  const [state, setState] = useState<State | null>(null);
  // Back from Ready re-opens the key form even though the lifecycle is past it.
  const [editingKey, setEditingKey] = useState(false);

  const load = async () => setState(await api.get<State>('/wizard/state'));
  useEffect(() => { void load(); }, []);

  if (!state) return <Empty>Loading…</Empty>;

  if (state.lifecycle === 'uninitialized' || editingKey) {
    return (
      <KeyStep
        onBack={state.lifecycle === 'uninitialized'
          ? async () => { await sessionApi.signOut().catch(() => {}); onReady(); }
          : () => setEditingKey(false)}
        onSaved={async () => { await load(); setEditingKey(false); }}
      />
    );
  }
  return <ReadyStep onBack={() => setEditingKey(true)} onReady={onReady} />;
}

export function keyError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.body.error === 'invalid_api_key') return 'OpenAI rejected that key. Check it and try again.';
    if (e.body.error === 'provider_unreachable') {
      return 'Could not reach OpenAI to check the key. Check this server\'s network and try again.';
    }
  }
  return e instanceof Error ? e.message : 'Could not save the key';
}

function KeyStep({ onBack, onSaved }: { onBack: () => void; onSaved: () => Promise<void> }) {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/wizard/provider', {
        provider: 'openai', apiKey,
        embeddingModel: 'openai:text-embedding-3-small', verify: true,
      });
      await onSaved();
    } catch (err) { setError(keyError(err)); }
    finally { setBusy(false); }
  };

  return (
    <OnboardingCard onBack={onBack} title="Add your OpenAI key"
      subtitle={<>
        Stored encrypted and used for embeddings and search. Get one at{' '}
        <a className="underline" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
          platform.openai.com/api-keys
        </a>.
      </>}>
      <form onSubmit={submit} className="space-y-4">
        <Input className="font-mono" type="password" placeholder="sk-…" autoComplete="off"
               value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        {error && (
          <Notice tone="danger">
            <Icon glyph={CircleAlert} size={16} />
            <span>{error}</span>
          </Notice>
        )}
        <Button variant="primary" type="submit" disabled={busy || !apiKey}>
          {busy ? 'Checking key…' : 'Continue'}
        </Button>
      </form>
    </OnboardingCard>
  );
}

type Phase = 'idle' | 'prepare' | 'finish';

function ReadyStep({ onBack, onReady }: { onBack: () => void; onReady: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [prepared, setPrepared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folderProblems, setFolderProblems] = useState<string[]>([]);
  const running = phase !== 'idle';

  const create = async () => {
    setError(null);
    try {
      if (!prepared) {
        setPhase('prepare');
        await api.post('/wizard/prepare', {});
        setPrepared(true);
      }
      setPhase('finish');
      const r = await api.post<{ scaffold?: ScaffoldReport }>('/wizard/finish', {});
      const problems = scaffoldProblems(r.scaffold);
      // The brain is ready either way; folders are the one thing worth stopping to say.
      if (problems.length > 0) { setFolderProblems(problems); setPhase('idle'); return; }
      onReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup failed');
      setPhase('idle');
    }
  };

  if (folderProblems.length > 0) {
    return (
      <OnboardingCard title="Your brain is ready">
        <Notice tone="warning" layout="stack">
          <p className="font-medium">Its folders were not created.</p>
          {folderProblems.map((p) => <p key={p} className="text-sm font-mono">{p}</p>)}
          <p className="text-sm">Open Schema and choose Create folders to retry. Nothing else is affected.</p>
          <Button variant="primary" onClick={onReady}>Continue</Button>
        </Notice>
      </OnboardingCard>
    );
  }

  if (running) {
    return (
      <OnboardingCard title="Creating your brain…">
        <div className="flex justify-center py-6" role="status" aria-live="polite">
          <Spinner size={32} />
        </div>
      </OnboardingCard>
    );
  }

  return (
    <OnboardingCard onBack={onBack} title="Your brain is ready to create"
      foot={<Button variant="primary" onClick={() => void create()}>{error ? 'Try again' : 'Create brain'}</Button>}>
      {error && (
        <Notice tone="danger">
          <Icon glyph={CircleAlert} size={16} />
          <span>{error}</span>
        </Notice>
      )}
    </OnboardingCard>
  );
}
