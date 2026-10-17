import { useEffect, useState } from 'react';
import { api, type Me } from '../api.ts';
import { ago, message } from '../lib.ts';
import { Button, Card, Empty, Notice, PageTitle, Spinner, Table, TableWrap } from '../ui/index.tsx';

type Client = { purpose: string; writeSource: string | null; expiresAt: string | null };

export function Connect({ me, onChange }: { me: Me; onChange: () => void }) {
  const [say, setSay] = useState<string | null>(null);
  const [clients, setClients] = useState<Client[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = (f: () => Promise<unknown>) => { setErr(null); f().catch((e) => setErr(message(e))); };
  // A load failure is surfaced, never left spinning: `People.tsx`/`Sources.tsx` do the same.
  useEffect(() => { api<{ clients: Client[] }>('/api/clients/me').then((r) => setClients(r.clients), (e) => setErr(message(e))); }, []);
  const agent = clients?.find((c) => c.purpose === 'agent');
  const soon = agent?.expiresAt && new Date(agent.expiresAt).getTime() - Date.now() < 14 * 86400_000;

  return (
    <div className="flex flex-col gap-4">
      <PageTitle>Connect your agent</PageTitle>
      {err && clients !== null && <Notice tone="danger">{err}</Notice>}
      <Card title="Set up an agent on a machine" subtitle="Creates a one-time key and the sentence to paste to your coding agent. Any previous unused key stops working.">
        <Button variant="primary" onClick={() => act(async () => setSay((await api<{ say: string }>('/api/me/join-key', { method: 'POST' })).say))}>Create join instructions</Button>
        {say && <div className="mt-3"><pre className="whitespace-pre-wrap break-all rounded bg-bg p-3 text-sm">{say}</pre>
          <Button onClick={() => navigator.clipboard.writeText(say)}>Copy</Button></div>}
      </Card>
      <Card title="Your agent's access">
        {err !== null && clients === null ? <Notice tone="danger">Could not load your agent's access. {err}</Notice>
          : clients === null ? <Spinner />
          : !agent ? <Empty>No agent connected yet.</Empty> : (
          <>
            {soon && <Notice tone="warning">The agent token expires {ago(agent.expiresAt)}. Collectors rotate it automatically; if they are not running, ask your agent to run <code>mobrain client issue agent --register</code>.</Notice>}
            <TableWrap><Table><thead><tr><th>Client</th><th>Writes to</th><th>Expires</th></tr></thead>
              <tbody>{clients.filter((c) => c.purpose !== 'ui').map((c, i) => <tr key={i}><td>{c.purpose}</td><td>{c.writeSource ?? '-'}</td><td>{ago(c.expiresAt)}</td></tr>)}</tbody>
            </Table></TableWrap>
          </>
        )}
      </Card>
      {me.grants.length > 0 && (
        // An owner and an admin read every company source implicitly and hold no
        // revocable grant row, so this card exists only for the grant the server
        // would let them PATCH — an empty list of toggles here would 404.
        <Card title="Company sources your agent reads" subtitle="You can read these in this UI either way. Untick to keep one out of your agent's context.">
          <ul className="text-sm">{me.grants.map((g) => (
            <li key={g.sourceId} className="py-1"><label className="flex items-center gap-2">
              <input type="checkbox" checked={g.agentReads} onChange={() => act(async () => {
                await api(`/api/me/grants/${g.sourceId}`, { method: 'PATCH', json: { agentReads: !g.agentReads } }); onChange(); })} />
              {g.name}</label></li>))}</ul>
        </Card>
      )}
    </div>
  );
}
