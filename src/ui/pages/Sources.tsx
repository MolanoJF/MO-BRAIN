import { useEffect, useState } from 'react';
import { api, type Me, type Source } from '../api.ts';
import { ago, encodeSlug, sourceStatusLine, type SourceStatus } from '../lib.ts';
import { Badge, Card, Empty, Notice, PageTitle, Spinner, Table, TableWrap } from '../ui/index.tsx';

type Collector = {
  slug: string; title: string; kind: string | null; enabled: boolean; cadence: string | null;
  lastRun: { status: string; startedAt: string; finishedAt: string | null; summary: string | null } | null;
  nextDue: string | null; errors: string[];
};
const tone = (s?: string) => (s === 'ok' ? 'ok' : s === 'partial' || s === 'running' ? 'warning' : s ? 'danger' : 'muted') as 'ok' | 'warning' | 'danger' | 'muted';

function SourceCard({ source }: { source: Source }) {
  const [rows, setRows] = useState<Collector[] | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [status, setStatus] = useState<SourceStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  useEffect(() => {
    api<{ collectors: Collector[] }>(`/api/sources/${encodeSlug(source.id)}/collectors`)
      .then((r) => setRows(r.collectors), (e) => setRowsError(String(e.message)));
    // gbrain's own view of the source (page count, last sync), through the caller's own ui client.
    api<SourceStatus>(`/api/sources/${encodeSlug(source.id)}/status`)
      .then(setStatus, (e) => setStatusError(String(e.message)));
  }, [source.id]);
  return (
    <Card title={source.name} subtitle={`${source.kind === 'company' ? 'Company source' : 'Private source'} · ${source.id}`}>
      <p className="mb-3 text-sm text-muted">
        {status === null && statusError === null ? <Spinner size={12} /> : sourceStatusLine(status, statusError)}
      </p>
      {rowsError !== null ? <Notice tone="danger">Could not load collectors: {rowsError}</Notice>
        : rows === null ? <Spinner /> : rows.length === 0 ? <Empty>No collectors. Ask your agent to connect a source.</Empty> : (
        <TableWrap><Table>
          <thead><tr><th>Collector</th><th>Kind</th><th>Cadence</th><th>Last run</th><th>Next</th><th>Notes</th></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.slug}>
              <td><a href={`/pages/${encodeSlug(source.id)}/${encodeSlug(c.slug)}`}>{c.title}</a>{!c.enabled && <> <Badge tone="muted">paused</Badge></>}</td>
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
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<{ sources: Source[] }>('/api/sources').then((r) => setSources(r.sources), (e) => setError(String(e.message))); }, []);
  return (
    <div className="flex flex-col gap-4">
      <PageTitle>Sources</PageTitle>
      <p className="text-muted">What feeds this brain, and when each collector last ran. To change a schedule or connect something new, ask your agent.</p>
      {error !== null ? <Notice tone="danger">Could not load sources: {error}</Notice>
        : sources === null ? <Spinner /> : sources.length === 0 ? <Empty>No sources you can read yet.</Empty>
        : sources.map((s) => <SourceCard key={s.id} source={s} />)}
    </div>
  );
}
