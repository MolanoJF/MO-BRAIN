import { useEffect, useState } from 'react';
import { ApiError, brainApi, orgApi, type SearchModeInfo } from '../api.ts';
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

function ModeSummary({ m }: { m: SearchModeInfo }) {
  return (
    <>
      <div className="flex justify-between">
        <span className="font-medium">{m.label}</span>
        <span className="font-mono text-sm text-muted">{m.relativeCost}× cost</span>
      </div>
      <p className="text-sm text-muted">{m.description}</p>
    </>
  );
}

/** Shows the active mode on its own; "Change" opens the others. */
function SearchModeCard({ onMsg }: { onMsg: (m: { ok: boolean; text: string }) => void }) {
  const [state, setState] = useState<{ mode: string | null; modes: SearchModeInfo[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  useEffect(() => {
    void brainApi.getSearchMode().then((r) => setState({ mode: r.mode, modes: r.modes })).catch(() => {});
  }, []);
  if (!state) return null;
  const active = state.modes.find((m) => m.id === state.mode) ?? null;
  const choose = async (id: string) => {
    setBusy(true);
    try {
      await brainApi.setSearchMode(id);
      setState({ ...state, mode: id });
      setChanging(false);
      onMsg({ ok: true, text: 'Search mode updated.' });
    } catch (e) {
      onMsg({ ok: false, text: e instanceof Error ? e.message : 'That did not work' });
    } finally { setBusy(false); }
  };
  const open = changing || active === null;
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium">Search mode</h2>
        {active && !changing && <Button disabled={busy} onClick={() => setChanging(true)}>Change</Button>}
        {active && changing && <Button disabled={busy} onClick={() => setChanging(false)}>Cancel</Button>}
      </div>
      {active && !changing && (
        <div className={`mt-3 ${PICKER_CARD} border-accent`}><ModeSummary m={active} /></div>
      )}
      {open && (
        <div className="mt-3 space-y-2">
          {state.modes.filter((m) => m.id !== state.mode).map((m) => (
            <button key={m.id} type="button" disabled={busy} className={PICKER_CARD}
                    onClick={() => void choose(m.id)}>
              <ModeSummary m={m} />
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

export function Admin() {
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
