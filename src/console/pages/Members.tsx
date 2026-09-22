import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Button, Card, Empty, Input, Notice, Select } from '../ui/index.tsx';

type Role = 'owner' | 'admin' | 'member' | 'viewer';
const INVITE_ROLES: Array<'admin' | 'member' | 'viewer'> = ['admin', 'member', 'viewer'];

type Member = {
  id: string;
  userId: string;
  role: Role;
  email: string;
  name: string | null;
  createdAt: string;
};

export function Members() {
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [claimUrl, setClaimUrl] = useState<string | null>(null);
  const [claimUntil, setClaimUntil] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await api.get<{ members: Member[] }>('/members');
    setMembers(r.members);
  };
  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : 'Load failed')); }, []);

  const step = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Step failed'); }
    finally { setBusy(false); }
  };

  const invite = () => step(async () => {
    const created = await api.post<{ id: string }>('/members', { email, role });
    const minted = await api.post<{ token: string; expiresAt: string }>(
      `/members/${created.id}/claim-link`,
      { email },
    );
    setClaimUrl(`${window.location.origin}/claim/${minted.token}`);
    setClaimUntil(minted.expiresAt);
    setEmail('');
  });

  const remint = (m: Member) => step(async () => {
    const minted = await api.post<{ token: string; expiresAt: string }>(
      `/members/${m.id}/claim-link`,
      { email: m.email },
    );
    setClaimUrl(`${window.location.origin}/claim/${minted.token}`);
    setClaimUntil(minted.expiresAt);
  });

  const offboard = (m: Member) => step(async () => {
    await api.delete(`/members/${m.id}`);
  });

  return (
    <div className="max-w-2xl space-y-8">
      <header>
        <h1 className="text-xl font-semibold">Members</h1>
        <p className="text-sm text-muted">Invite by email. The claim URL is shown once.</p>
      </header>

      {error && <div className="text-[length:var(--control-font)] text-danger">{error}</div>}

      <section className="space-y-3">
        <h2 className="font-medium">Invite</h2>
        <Input type="email" placeholder="Email"
               value={email} onChange={(e) => setEmail(e.target.value)} />
        <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {INVITE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </Select>
        <Button variant="primary" disabled={busy || !email} onClick={() => void invite()}>
          {busy ? 'Working…' : 'Invite'}
        </Button>
      </section>

      {claimUrl && (
        <Notice layout="stack">
          <p className="font-medium">Claim URL — shown once, not recoverable</p>
          <p className="font-mono break-all">{claimUrl}</p>
          {claimUntil && (
            <p className="text-xs">Expires {new Date(claimUntil).toLocaleString()}</p>
          )}
          {/* Not `text-muted`: a Notice paints its own copy colour per theme,
              and muting one line inside it drops that line out of the warning
              palette — the "save it now" line is the one that must not fade. */}
          <p>Save it now. We cannot show this link again.</p>
        </Notice>
      )}

      <section className="space-y-3">
        <h2 className="font-medium">Roster</h2>
        {members.length === 0 && <Empty>No members yet.</Empty>}
        {members.map((m) => (
          <Card key={m.id} className="flex items-center justify-between gap-3">
            <div>
              <div>{m.email}</div>
              <div className="text-[length:var(--control-font)] text-muted font-mono">{m.role}</div>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button disabled={busy} onClick={() => void remint(m)}>
                Claim link
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void offboard(m)}>
                Offboard
              </Button>
            </div>
          </Card>
        ))}
      </section>
    </div>
  );
}
