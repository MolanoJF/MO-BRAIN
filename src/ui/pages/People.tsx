import { useCallback, useEffect, useState } from 'react';
import { api, type Me, type Role, type Source } from '../api.ts';
import { message } from '../lib.ts';
import { Button, Card, ConfirmButton, Empty, Field, Input, Notice, PageTitle, Select, Spinner, Table, TableWrap } from '../ui/index.tsx';

type Person = { id: string; email: string; name: string | null; role: Role; status: string; grants: { sourceId: string; agentReads: boolean }[] };
type PeopleData = { mode: 'personal' | 'company'; users: Person[]; sources: (Source & { ownerUserId: string | null })[] };

export function People({ me, onChange }: { me: Me; onChange: () => void }) {
  const [d, setD] = useState<PeopleData | null>(null); const [err, setErr] = useState<string | null>(null);
  const [email, setEmail] = useState(''); const [role, setRole] = useState<Role>('member'); const [claimUrl, setClaimUrl] = useState<string | null>(null);
  const [newSource, setNewSource] = useState('');
  // A load failure is surfaced, never left spinning: `Sources.tsx`/`Schema.tsx` do the same.
  const load = useCallback(() => api<PeopleData>('/api/people').then(setD, (e) => setErr(message(e))), []);
  useEffect(() => { load(); }, [load]);
  const act = async (f: () => Promise<unknown>) => { setErr(null); try { await f(); await load(); onChange(); } catch (e) { setErr(message(e)); } };

  if (err !== null && d === null) return (
    <div className="flex flex-col gap-4">
      <PageTitle>People & access</PageTitle>
      <Notice tone="danger">Could not load people and access. {err}</Notice>
    </div>
  );
  if (!d) return <Spinner />;
  const owner = me.user.role === 'owner';
  const company = d.sources.filter((s) => s.kind === 'company' && s.status === 'active');
  const people = d.users.filter((u) => u.status !== 'disabled');

  return (
    <div className="flex flex-col gap-4">
      <PageTitle>People & access</PageTitle>
      {err && <Notice tone="danger">{err}</Notice>}
      <Card title={d.mode === 'company' ? 'Company mode' : 'Personal mode'}
        subtitle={d.mode === 'company' ? 'People can be invited. Each has a private space; company sources are shared by grant.' : 'This brain is yours alone. Switch to company mode to invite people.'}>
        {owner && <Button onClick={() => act(() => api('/api/people/mode', { json: { mode: d.mode === 'company' ? 'personal' : 'company' } }))}>
          Switch to {d.mode === 'company' ? 'personal' : 'company'} mode</Button>}
      </Card>
      {d.mode === 'company' && (<>
        <Card title="Invite someone">
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); act(async () => {
            const r = await api<{ claimUrl: string }>('/api/people/invite', { json: { email, role } }); setClaimUrl(r.claimUrl); setEmail(''); }); }}>
            <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="member">member</option><option value="viewer">viewer</option>{owner && <option value="admin">admin</option>}</Select></Field>
            <Button variant="primary" type="submit">Create invite</Button>
          </form>
          {claimUrl && <Notice tone="ok" layout="stack">Send this link to them (valid 24 hours, works once):<code className="break-all">{claimUrl}</code>
            <Button onClick={() => navigator.clipboard.writeText(claimUrl)}>Copy link</Button></Notice>}
        </Card>
        <Card title="People and grants" subtitle="A tick lets that person read the company source. 'agent' means their agent reads it too.">
          <TableWrap><Table><thead><tr><th>Person</th><th>Role</th><th>Status</th>{company.map((s) => <th key={s.id}>{s.name}</th>)}<th /></tr></thead>
            <tbody>{people.map((u) => {
              const fixed = u.role === 'owner' || u.role === 'admin';
              return (<tr key={u.id}>
                <td>{u.name ?? u.email}<div className="text-muted text-sm">{u.email}</div></td>
                <td>{u.role === 'owner' || u.id === me.user.id ? u.role : (
                  <Select value={u.role} onChange={(e) => act(() => api(`/api/people/${u.id}/role`, { json: { role: e.target.value } }))}>
                    <option value="member">member</option><option value="viewer">viewer</option>{owner && <option value="admin">admin</option>}</Select>)}</td>
                <td>{u.status}</td>
                {company.map((s) => {
                  const g = u.grants.find((x) => x.sourceId === s.id);
                  return <td key={s.id}>{fixed ? 'all' : (
                    <label className="flex items-center gap-1 text-sm">
                      <input type="checkbox" aria-label={`${u.name ?? u.email}: ${s.name}`} checked={!!g} onChange={() => act(() => g
                        ? api(`/api/people/${u.id}/grants/${s.id}`, { method: 'DELETE' })
                        : api(`/api/people/${u.id}/grants/${s.id}`, { method: 'PUT', json: { agentReads: true } }))} />
                      {g && <span className="text-muted">{g.agentReads ? 'agent' : 'ui only'}</span>}
                    </label>)}</td>;
                })}
                <td>{u.role !== 'owner' && u.id !== me.user.id && (owner || u.role !== 'admin') && (
                  <ConfirmButton label="Offboard" confirmLabel="Revoke all access?" onConfirm={() => act(() => api(`/api/people/${u.id}/offboard`, { json: {} }))} />)}</td>
              </tr>);
            })}</tbody></Table></TableWrap>
        </Card>
        <Card title="Company sources">
          {company.length === 0 ? <Empty>None.</Empty> : (
            <ul className="text-sm">{company.map((s) => (
              <li key={s.id} className="flex items-center gap-2 py-1">{s.name} <code className="text-muted">{s.id}</code>
                <ConfirmButton label="Archive" confirmLabel="Archive for everyone?" onConfirm={() => act(() => api(`/api/sources/${s.id}/archive`, { json: {} }))} /></li>))}</ul>)}
          <form className="mt-3 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); act(async () => { await api('/api/sources/company', { json: { name: newSource } }); setNewSource(''); }); }}>
            <Field label="New company source"><Input value={newSource} onChange={(e) => setNewSource(e.target.value)} required /></Field>
            <Button type="submit">Add</Button>
          </form>
        </Card>
      </>)}
    </div>
  );
}
