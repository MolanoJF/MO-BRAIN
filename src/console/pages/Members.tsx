import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Button, Card, Empty, Input, Notice, PageTitle, Select } from '../ui/index.tsx';

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

type PrivateSpaceOutcome = { ok: true; spaceId: string; sourceId: string; connectionId: string };
type InviteResponse = {
  id: string;
  privateSpace?: { ok: boolean; spaceId?: string; connectionId?: string; error?: string };
};
type SpaceNotice = { memberId: string; ok: boolean; message: string };

export function Members() {
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [claimUrl, setClaimUrl] = useState<string | null>(null);
  const [claimUntil, setClaimUntil] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [privateSpacesEnabled, setPrivateSpacesEnabled] = useState<boolean | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [inviteWarning, setInviteWarning] =
    useState<{ memberId: string; email: string; error: string } | null>(null);
  const [spaceNotice, setSpaceNotice] = useState<SpaceNotice | null>(null);

  const load = async () => {
    const r = await api.get<{ members: Member[] }>('/members');
    setMembers(r.members);
  };
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : 'Load failed'));
    void api.get<{ enabled: boolean }>('/org/private-spaces')
      .then((r) => setPrivateSpacesEnabled(r.enabled))
      .catch((e) => setError(e instanceof Error ? e.message : 'Load failed'));
  }, []);

  const step = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Step failed'); }
    finally { setBusy(false); }
  };

  const invite = () => step(async () => {
    const created = await api.post<InviteResponse>('/members', { email, role });
    const minted = await api.post<{ token: string; expiresAt: string }>(
      `/members/${created.id}/claim-link`,
      { email },
    );
    setClaimUrl(`${window.location.origin}/claim/${minted.token}`);
    setClaimUntil(minted.expiresAt);
    setInviteWarning(
      created.privateSpace && created.privateSpace.ok === false
        ? { memberId: created.id, email, error: created.privateSpace.error ?? 'unknown' }
        : null,
    );
    setSpaceNotice(null);
    setEmail('');
  });

  const provision = async (memberId: string) => {
    setBusy(true); setError(null); setSpaceNotice(null);
    try {
      const r = await api.post<PrivateSpaceOutcome>(
        `/members/${encodeURIComponent(memberId)}/private-space`,
      );
      setSpaceNotice({ memberId, ok: true, message: `Private Source ready (${r.sourceId})` });
      setInviteWarning((w) => (w && w.memberId === memberId ? null : w));
      await load();
    } catch (e) {
      setSpaceNotice({ memberId, ok: false, message: e instanceof Error ? e.message : 'Provision failed' });
    } finally { setBusy(false); }
  };

  const togglePrivateSpaces = async (enabled: boolean) => {
    setSettingsBusy(true); setError(null);
    try {
      const r = await api.patch<{ enabled: boolean }>('/org/private-spaces', { enabled });
      setPrivateSpacesEnabled(r.enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally { setSettingsBusy(false); }
  };

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
        <PageTitle>Members</PageTitle>
        <p className="text-sm text-muted">Invite by email. The claim URL is shown once.</p>
      </header>

      {error && <div className="text-[length:var(--control-font)] text-danger">{error}</div>}

      <section className="space-y-3">
        <h2 className="font-medium">Org settings</h2>
        <label className="flex items-center gap-2">
          <input type="checkbox"
                 checked={privateSpacesEnabled === true}
                 disabled={settingsBusy || privateSpacesEnabled === null}
                 onChange={(e) => void togglePrivateSpaces(e.target.checked)} />
          <span>Give each member a private Source</span>
        </label>
        {settingsBusy && <p className="text-xs text-muted">Saving…</p>}
      </section>

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
              palette — this line is the one that must not fade. */}
          <p>Send this link to them. They'll create their account, get their own private Source, and see the company Sources you grant on the Access tab. It expires in 24 hours.</p>
        </Notice>
      )}

      {inviteWarning && (
        <Notice layout="stack">
          <p className="font-medium text-warning">Private Source not provisioned</p>
          <p>
            {inviteWarning.email} was invited, but their private Source failed: {inviteWarning.error}
          </p>
          {spaceNotice?.memberId === inviteWarning.memberId && !spaceNotice.ok && (
            <p className="text-danger">{spaceNotice.message}</p>
          )}
          <div>
            <Button disabled={busy}
                    onClick={() => void provision(inviteWarning.memberId)}>
              Provision private Source
            </Button>
          </div>
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
              {spaceNotice?.memberId === m.id && (
                <div className={`text-xs ${spaceNotice.ok ? 'text-muted' : 'text-danger'}`}>
                  {spaceNotice.message}
                </div>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <Button disabled={busy} onClick={() => void provision(m.id)}>
                Private Source
              </Button>
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
