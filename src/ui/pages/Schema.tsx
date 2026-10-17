import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge, Card, Empty, Notice, PageTitle, Spinner, Table, TableWrap } from '../ui/index.tsx';

type SchemaView = {
  active: string | null;
  layers: { layer: string; name: string; version: string | null }[];
  types: { name: string; primitive: string; prefixes: string[]; aliases: string[]; layer: string; count: number | null }[];
  linkTypes: { name: string; layer: string }[];
  orphans: { slug?: string }[] | null;
  coreLock: { ok: boolean; problems: string[] };
};
const layerTone = (l: string) => (l === 'brain' ? 'ok' : 'neutral') as 'ok' | 'neutral';

export function Schema() {
  const [v, setV] = useState<SchemaView | null>(null);
  useEffect(() => { api<SchemaView>('/api/schema').then(setV); }, []);
  if (!v) return <Spinner />;
  return (
    <div className="flex flex-col gap-4">
      <PageTitle>Schema</PageTitle>
      {v.coreLock.ok
        ? <Notice tone="ok">Core schema intact. Active pack: {v.active}.</Notice>
        : <Notice tone="danger">The core schema lock is broken: {v.coreLock.problems.join(', ')}. Ask your agent to run <code>mobrain schema check</code> and fix it.</Notice>}
      <p className="text-muted">Read-only. Your agent changes the schema through gbrain, in the <code>mobrain-brain</code> layer.</p>
      <Card title="Layers">
        <ul className="text-sm">{v.layers.map((l) => <li key={l.name}><Badge tone={layerTone(l.layer)}>{l.layer}</Badge> {l.name} {l.version ?? '(missing)'}</li>)}</ul>
      </Card>
      <Card title={`Page types (${v.types.length})`}>
        <TableWrap><Table align={['left', 'left', 'left', 'left', 'left', 'right']}>
          <thead><tr><th>Type</th><th>Layer</th><th>Primitive</th><th>Folders</th><th>Aliases</th><th>Pages</th></tr></thead>
          <tbody>{v.types.map((t) => (
            <tr key={t.name}><td>{t.name}</td><td><Badge tone={layerTone(t.layer)}>{t.layer}</Badge></td><td>{t.primitive}</td>
              <td><code>{t.prefixes.join(' ')}</code></td><td>{t.aliases.join(', ')}</td><td>{t.count ?? '-'}</td></tr>))}
          </tbody>
        </Table></TableWrap>
      </Card>
      <Card title={`Link types (${v.linkTypes.length})`}>
        <div className="flex flex-wrap gap-2">{v.linkTypes.map((l) => <Badge key={l.name} tone={layerTone(l.layer)}>{l.name}</Badge>)}</div>
      </Card>
      <Card title="Pages with no type" subtitle="Pages the schema does not recognise. Your agent can file them.">
        {!v.orphans ? <Empty>Not available.</Empty> : v.orphans.length === 0 ? <Empty>None.</Empty>
          : <ul className="text-sm">{v.orphans.map((o, i) => <li key={o.slug ?? i}><code>{o.slug ?? JSON.stringify(o)}</code></li>)}</ul>}
      </Card>
    </div>
  );
}
