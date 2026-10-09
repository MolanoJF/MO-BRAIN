import { useEffect, useState } from 'react';
import { ApiError, credentialsApi, myConnectionApi, type MyConnection } from '../api.ts';
import { Button, Card, Input, Notice } from '../ui/index.tsx';
import { useOrg } from '../OrgContext.tsx';
import { useSource } from '../SourceContext.tsx';
import { renameSourceError } from './Sources.tsx';
import { RemotePanel, type RemoteApi } from '../RemotePanel.tsx';

const myRemoteApi: RemoteApi = {
  set: (body) => myConnectionApi.setRemote(body),
  push: () => myConnectionApi.pushRemote(),
  clear: () => myConnectionApi.clearRemote(),
};

export function toggleRead(current: string[], id: string): string[] {
  return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}

export const MY_BRAIN_INTRO = 'Your private Space and what your own agent can read.';
export const MY_BRAIN_ADMIN_INTRO = 'Organization-wide Sources are under Sources.';

/** The org-wide sentence points at an admin-only tab, so only admins see it. */
export function myBrainIntro(role: string | undefined): string {
  const admin = role === 'owner' || role === 'admin';
  return admin ? `${MY_BRAIN_INTRO} ${MY_BRAIN_ADMIN_INTRO}` : MY_BRAIN_INTRO;
}

/**
 * Zones spec §1 — the member's own zone. Their private Space is theirs alone;
 * here they choose which company Spaces (among those an admin granted) their
 * own agent may READ. It always writes only to their private Space.
 */
export function MyBrain() {
  const [data, setData] = useState<MyConnection | null>(null);
  const [reads, setReads] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editName, setEditName] = useState<string | null>(null);
  const [memberToken, setMemberToken] = useState<boolean | null>(null);
  const { org } = useOrg();
  const { reload: reloadSources } = useSource();

  const load = async () => {
    try {
      const d = await myConnectionApi.get();
      setData(d);
      setReads(d.connection?.readSpaceIds ?? []);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError && e.body.error === 'no_private_space'
        ? 'You do not have a private Source yet. Ask an admin to retry provisioning it.'
        : e instanceof Error ? e.message : 'Could not load' });
    }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    void credentialsApi.status()
      .then((c) => setMemberToken(c.github.member.configured))
      .catch(() => setMemberToken(false));
  }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try { await myConnectionApi.setReads(reads); await load(); setMsg({ ok: true, text: 'Saved.' }); }
    catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError && e.body.error === 'connection_pending'
        ? 'Finish claiming your invite first.'
        : e instanceof Error ? e.message : 'Save failed' });
    } finally { setBusy(false); }
  };

  const saveName = async () => {
    if (editName === null || !data) return;
    const invalid = renameSourceError(data.space.name, editName);
    if (invalid !== null) { setMsg({ ok: false, text: invalid }); return; }
    setBusy(true); setMsg(null);
    try {
      await myConnectionApi.renameSpace(editName.trim());
      setEditName(null);
      await load();
      await reloadSources();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Rename failed' });
    } finally { setBusy(false); }
  };

  if (!data) return msg ? <Notice tone="danger">{msg.text}</Notice> : <p className="text-sm text-muted">Loading…</p>;
  const saved = data.connection?.readSpaceIds ?? [];
  const dirty = saved.length !== reads.length || saved.some((id) => !reads.includes(id));

  return (
    <div className="space-y-6 max-w-xl">
      <p className="text-sm text-muted">{myBrainIntro(org?.role)}</p>
      <Card>
        {editName !== null ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Space name" className="max-w-xs" value={editName}
                   onChange={(e) => setEditName(e.target.value)} />
            <Button variant="primary"
                    disabled={busy || renameSourceError(data.space.name, editName) !== null}
                    onClick={() => void saveName()}>
              Save
            </Button>
            <Button disabled={busy} onClick={() => setEditName(null)}>Cancel</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <h2 className="font-medium">{data.space.name}</h2>
            <Button disabled={busy} onClick={() => setEditName(data.space.name)}>Edit name</Button>
          </div>
        )}
        <p className="text-sm text-muted">
          Your private Source (<span className="font-mono">{data.space.sourceId}</span>). Only you can see it —
          admins included.
        </p>
      </Card>
      <Card>
        <RemotePanel sourceId={data.space.sourceId} gitRemote={data.space.gitRemote} busy={busy}
                     api={myRemoteApi} onChanged={load}
                     token={{ stored: memberToken, scope: 'member' }} />
      </Card>
      <Card>
        <h2 className="font-medium">What your agent can read</h2>
        {data.readable.length === 0 ? (
          <p className="text-sm text-muted">No company Sources have been shared with you yet.</p>
        ) : (
          <ul className="space-y-1">
            {data.readable.map((s) => (
              <li key={s.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={reads.includes(s.id)}
                         onChange={() => setReads(toggleRead(reads, s.id))} />
                  {s.name} <span className="font-mono text-muted">({s.sourceId})</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <Button variant="primary" disabled={busy || !dirty || data.connection === null} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </Card>
      {msg && <Notice tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</Notice>}
    </div>
  );
}
