import { useEffect, useState } from 'react';
import { ApiError, brainApi, orgApi, type SearchModeInfo } from '../api.ts';
import { MEASURED_COST_DISCLAIMER } from '../../control/lifecycle.ts';
import { useOrg } from '../OrgContext.tsx';
import { Button, Card, Input, Notice } from '../ui/index.tsx';

/** What the switch says, from where the brain is now. Exported for tests. */
export function switchCopy(mode: 'personal' | 'company'): { title: string; body: string; action: string } {
  return mode === 'personal'
    ? {
      title: 'Personal brain',
      body: 'Only you use this brain. Turn it into a company brain to add shared Sources, invite teammates and grant them access. Your own Source stays private either way.',
      action: 'Turn into a company brain',
    }
    : {
      title: 'Company brain',
      body: 'Teammates can be invited and granted company Sources. Each person keeps a private Source nobody else can see. You can switch back only while you are the only member.',
      action: 'Switch back to a personal brain',
    };
}

/** A selectable card is a `<button>`, which `Card` (a `<section>`) cannot become. */
const PICKER_CARD =
  'w-full text-left p-3 rounded-[var(--radius)] border border-border bg-surface ' +
  'enabled:hover:bg-subtle disabled:opacity-45 disabled:cursor-not-allowed';

function SearchModeCard({ onMsg }: { onMsg: (m: { ok: boolean; text: string }) => void }) {
  const [state, setState] = useState<{ mode: string | null; modes: SearchModeInfo[] } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void brainApi.getSearchMode().then((r) => setState({ mode: r.mode, modes: r.modes })).catch(() => {});
  }, []);
  if (!state) return null;
  const { modes } = state;
  const measured = modes.filter((m) => m.measuredCost !== null);
  const choose = async (id: string) => {
    setBusy(true);
    try {
      await brainApi.setSearchMode(id);
      setState({ ...state, mode: id });
      onMsg({ ok: true, text: 'Search mode updated.' });
    } catch (e) {
      onMsg({ ok: false, text: e instanceof Error ? e.message : 'That did not work' });
    } finally { setBusy(false); }
  };
  return (
    <Card>
      <h2 className="font-medium">Search mode</h2>
      {measured.length === modes.length ? (
        <p className="text-sm text-muted">
          On this deployment, the most expensive mode costs about{' '}
          {Math.max(...measured.map((m) => m.measuredCost!))}× the cheapest.{' '}
          {MEASURED_COST_DISCLAIMER}
        </p>
      ) : (
        <p className="text-sm text-muted">
          Not measured on this deployment. Upstream reports roughly{' '}
          {Math.max(...modes.map((m) => m.relativeCost))}× between the cheapest and most
          expensive mode; your own spread will differ. The Spend page shows what you
          actually pay once the brain has run for a few days.
        </p>
      )}
      <div className="mt-3 space-y-2">
        {modes.map((m) => (
          <button key={m.id} type="button" disabled={busy} aria-pressed={state.mode === m.id}
                  className={state.mode === m.id ? `${PICKER_CARD} border-accent` : PICKER_CARD}
                  onClick={() => void choose(m.id)}>
            <div className="flex justify-between">
              <span className="font-medium">{m.label}</span>
              <span className="font-mono text-sm text-muted">{m.relativeCost}× cost</span>
            </div>
            <p className="text-sm text-muted">{m.description}</p>
          </button>
        ))}
      </div>
    </Card>
  );
}

export function General() {
  const { org, reload } = useOrg();
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (org) setName(org.name); }, [org?.name]);
  if (!org) return <p className="text-sm text-muted">Loading…</p>;
  const copy = switchCopy(org.brainMode);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); await reload(); setMsg({ ok: true, text: ok }); setConfirming(false); }
    catch (e) {
      const code = e instanceof ApiError ? e.body.error : null;
      setMsg({
        ok: false,
        text: code === 'team_exists'
          ? 'Other people are members or have an open invite. Remove them first to switch back.'
          : e instanceof Error ? e.message : 'That did not work',
      });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6 max-w-xl">
      <Card>
        <h2 className="font-medium">Name</h2>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
        <Button disabled={busy || !name.trim() || name.trim() === org.name}
                onClick={() => run(() => orgApi.rename(name.trim()), 'Renamed.')}>
          Save name
        </Button>
      </Card>

      {org.role === 'owner' && (
        <Card>
          <h2 className="font-medium">{copy.title}</h2>
          <p className="text-sm text-muted">{copy.body}</p>
          {!confirming ? (
            <Button onClick={() => setConfirming(true)} disabled={busy}>{copy.action}</Button>
          ) : org.brainMode === 'personal' ? (
            <div className="space-y-2">
              <Input placeholder="Company name (optional)" value={companyName}
                     onChange={(e) => setCompanyName(e.target.value)} />
              <Button variant="primary" disabled={busy}
                      onClick={() => run(() => orgApi.setMode('company', companyName.trim() || undefined),
                        'This is now a company brain. Members and Access are in Settings.')}>
                Confirm
              </Button>
            </div>
          ) : (
            <Button variant="primary" disabled={busy}
                    onClick={() => run(() => orgApi.setMode('personal'), 'This is a personal brain again.')}>
              Confirm
            </Button>
          )}
        </Card>
      )}

      {(org.role === 'owner' || org.role === 'admin') && <SearchModeCard onMsg={setMsg} />}

      {msg && <Notice tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</Notice>}
    </div>
  );
}
