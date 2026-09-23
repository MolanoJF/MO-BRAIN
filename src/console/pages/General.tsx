import { useEffect, useState } from 'react';
import { ApiError, orgApi } from '../api.ts';
import { useOrg } from '../OrgContext.tsx';
import { Button, Card, Input, Notice } from '../ui/index.tsx';

/** What the switch says, from where the brain is now. Exported for tests. */
export function switchCopy(mode: 'personal' | 'company'): { title: string; body: string; action: string } {
  return mode === 'personal'
    ? {
      title: 'Personal brain',
      body: 'Only you use this brain. Turn it into a company brain to add shared Spaces, invite teammates and grant them access. Your own Space stays private either way.',
      action: 'Turn into a company brain',
    }
    : {
      title: 'Company brain',
      body: 'Teammates can be invited and granted company Spaces. Each person keeps a private Space nobody else can see. You can switch back only while you are the only member.',
      action: 'Switch back to a personal brain',
    };
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

      {msg && <Notice tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</Notice>}
    </div>
  );
}
