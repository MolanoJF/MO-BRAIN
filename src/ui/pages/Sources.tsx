import { useEffect, useState } from 'react';
import { api, type Me, type Source } from '../api.ts';
import { ago } from '../lib.ts';
import { Badge, Card, Empty, PageTitle, Spinner, Table, TableWrap } from '../ui/index.tsx';

type Collector = {
  slug: string; title: string; kind: string | null; enabled: boolean; cadence: string | null;
  lastRun: { status: string; startedAt: string; finishedAt: string | null; summary: string | null } | null;
  nextDue: string | null; errors: string[];
};
const tone = (s?: string) => (s === 'ok' ? 'ok' : s === 'partial' || s === 'running' ? 'warning' : s ? 'danger' : 'muted') as 'ok' | 'warning' | 'danger' | 'muted';

function SourceCard({ source }: { source: Source }) {
  const [rows, setRows] = useState<Collector[] | null>(null);
  useEffect(() => { api<{ collectors: Collector[] }>(`/api/sources/${source.id}/collectors`).then((r) => setRows(r.collectors), () => setRows([])); }, [source.id]);
  return (
    <Card title={source.name} subtitle={`${source.kind === 'company' ? 'Company source' : 'Private source'} · ${source.id}`}>
      {rows === null ? <Spinner /> : rows.length === 0 ? <Empty>No collectors. Ask your agent to connect a source.</Empty> : (
        <TableWrap><Table>
          <thead><tr><th>Collector</th><th>Kind</th><th>Cadence</th><th>Last run</th><th>Next</th><th>Notes</th></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.slug}>
              <td><a href={`/pages/${source.id}/${c.slug}`}>{c.title}</a>{!c.enabled && <> <Badge tone="muted">paused</Badge></>}</td>
              <td>{c.kind ?? '-'}</td>
              <td>{c.cadence ?? '-'}</td>
              <td>{c.lastRun ? <><Badge tone={tone(c.lastRun.status)}>{c.lastRun.status}</Badge> {ago(c.lastRun.finishedAt ?? c.lastRun.startedAt)}</> : 'never'}</td>
              <td>{c.nextDue ? ago(c.nextDue) : '-'}</td>
              <td className="text-muted">{c.errors.length ? `invalid: ${c.errors.join(', ')}` : c.lastRun?.summary ?? ''}</td>
            </tr>))}
          </tbody>
        </Table></TableWrap>
      )}
    </Card>
  );
}

export function Sources({ me: _me }: { me: Me }) {
  const [sources, setSources] = useState<Source[] | null>(null);
  useEffect(() => { api<{ sources: Source[] }>('/api/sources').then((r) => setSources(r.sources)); }, []);
  return (
    <div className="flex flex-col gap-4">
      <PageTitle>Sources</PageTitle>
      <p className="text-muted">What feeds this brain, and when each collector last ran. To change a schedule or connect something new, ask your agent.</p>
      {sources === null ? <Spinner /> : sources.map((s) => <SourceCard key={s.id} source={s} />)}
    </div>
  );
}
