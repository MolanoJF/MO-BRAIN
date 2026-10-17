import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { ago } from '../lib.ts';
import { Badge, Card, Empty, Notice, PageTitle, Spinner, Table, TableWrap } from '../ui/index.tsx';

type Activity = {
  jobs: Record<string, unknown>[] | { error: string };
  runs: { id: string; email: string; sourceId: string; collector: string; startedAt: string; finishedAt: string | null; status: string; summary: string | null }[];
  audit: { at: string; actor: string | null; action: string; target: string | null }[];
};

export function Activity() {
  const [a, setA] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<Activity>('/api/activity').then(setA, (e) => setError(String(e.message))); }, []);
  if (error !== null) {
    return (
      <div className="flex flex-col gap-4">
        <PageTitle>Activity</PageTitle>
        <Notice tone="danger">Could not load activity: {error}. Ask your agent to run <code>mobrain status --detail</code>.</Notice>
      </div>
    );
  }
  if (!a) return <Spinner />;
  const jobs = Array.isArray(a.jobs) ? a.jobs : [];
  return (
    <div className="flex flex-col gap-4">
      <PageTitle>Activity</PageTitle>
      <Card title="Collector runs">
        {a.runs.length === 0 ? <Empty>No runs yet.</Empty> : (
          <TableWrap><Table><thead><tr><th>When</th><th>Who</th><th>Collector</th><th>Status</th><th>Summary</th></tr></thead>
            <tbody>{a.runs.map((r) => (
              <tr key={r.id}><td>{ago(r.startedAt)}</td><td>{r.email}</td><td>{r.sourceId} · {r.collector.replace('system/collectors/', '')}</td>
                <td><Badge tone={r.status === 'ok' ? 'ok' : r.status === 'running' || r.status === 'partial' ? 'warning' : 'danger'}>{r.status}</Badge></td>
                <td className="text-muted">{r.summary ?? ''}</td></tr>))}</tbody></Table></TableWrap>)}
      </Card>
      <Card title="gbrain jobs" subtitle="Sync, embedding, extraction and maintenance that gbrain runs itself.">
        {!Array.isArray(a.jobs) ? <Empty>Unavailable: {a.jobs.error}</Empty> : jobs.length === 0 ? <Empty>No jobs.</Empty> : (
          <TableWrap><Table><thead><tr><th>Job</th><th>Status</th><th>When</th></tr></thead>
            <tbody>{jobs.map((j, i) => (
              <tr key={String(j.id ?? i)}><td>{String(j.name ?? j.type ?? '-')}</td><td>{String(j.status ?? '-')}</td>
                <td>{ago((j.finished_at ?? j.updated_at ?? j.created_at) as string | undefined)}</td></tr>))}</tbody></Table></TableWrap>)}
      </Card>
      <Card title="Changes to people and access">
        {a.audit.length === 0 ? <Empty>Nothing yet.</Empty> : (
          <TableWrap><Table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Target</th></tr></thead>
            <tbody>{a.audit.map((e, i) => <tr key={i}><td>{ago(e.at)}</td><td>{e.actor ?? 'system'}</td><td>{e.action}</td><td>{e.target ?? ''}</td></tr>)}</tbody></Table></TableWrap>)}
      </Card>
    </div>
  );
}
