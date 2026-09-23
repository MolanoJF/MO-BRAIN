import { useEffect, useState } from 'react';
import { ApiError, myConnectionApi, type MyConnection } from '../api.ts';
import { Button, Card, Notice } from '../ui/index.tsx';

export function toggleRead(current: string[], id: string): string[] {
  return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
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

  const load = async () => {
    try {
      const d = await myConnectionApi.get();
      setData(d);
      setReads(d.connection?.readSpaceIds ?? []);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError && e.body.error === 'no_private_space'
        ? 'You do not have a private Space yet. Ask an admin to retry provisioning it.'
        : e instanceof Error ? e.message : 'Could not load' });
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try { await myConnectionApi.setReads(reads); await load(); setMsg({ ok: true, text: 'Saved.' }); }
    catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError && e.body.error === 'connection_pending'
        ? 'Finish claiming your invite first.'
        : e instanceof Error ? e.message : 'Save failed' });
    } finally { setBusy(false); }
  };

  if (!data) return msg ? <Notice tone="danger">{msg.text}</Notice> : <p className="text-sm text-muted">Loading…</p>;
  const saved = data.connection?.readSpaceIds ?? [];
  const dirty = saved.length !== reads.length || saved.some((id) => !reads.includes(id));

  return (
    <div className="space-y-6 max-w-xl">
      <Card>
        <h2 className="font-medium">{data.space.name}</h2>
        <p className="text-sm text-muted">
          Your private Space (<span className="font-mono">{data.space.sourceId}</span>). Only you can see it —
          admins included.
        </p>
      </Card>
      <Card>
        <h2 className="font-medium">What your agent can read</h2>
        {data.readable.length === 0 ? (
          <p className="text-sm text-muted">No company Spaces have been shared with you yet.</p>
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
