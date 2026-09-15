import { useEffect, useState } from 'react';
import { api } from '../api.ts';

type Role = 'owner' | 'admin' | 'member' | 'viewer';
const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

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

      {error && <div className="text-danger text-sm">{error}</div>}

      <section className="space-y-3">
        <h2 className="font-medium">Invite</h2>
        <input className="field" type="email" placeholder="Email"
               value={email} onChange={(e) => setEmail(e.target.value)} />
        <select className="field" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button className="btn-primary" disabled={busy || !email}
                onClick={() => void invite()}>
          {busy ? 'Working…' : 'Invite'}
        </button>
      </section>

      {claimUrl && (
        <div className="card border-warning space-y-2">
          <p className="text-sm font-medium">Claim URL — shown once, not recoverable</p>
          <p className="font-mono text-sm break-all">{claimUrl}</p>
          {claimUntil && (
            <p className="text-xs text-muted">Expires {new Date(claimUntil).toLocaleString()}</p>
          )}
          <p className="text-sm text-muted">
            Save it now. We cannot show this link again.
          </p>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="font-medium">Roster</h2>
        {members.length === 0 && <p className="text-sm text-muted">No members yet.</p>}
        {members.map((m) => (
          <div key={m.id} className="card flex items-center justify-between gap-3">
            <div>
              <div>{m.email}</div>
              <div className="text-sm text-muted font-mono">{m.role}</div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button className="nav-item" disabled={busy} onClick={() => void remint(m)}>
                Claim link
              </button>
              <button className="nav-item text-danger" disabled={busy}
                      onClick={() => void offboard(m)}>
                Offboard
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
