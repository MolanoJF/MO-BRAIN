import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Card, Metric, Notice, PageTitle, Spinner } from '../ui/index.tsx';

type Health = { ok: boolean; db: boolean; gbrain: boolean; pin: { expected: string; running: string | null; matches: boolean } };
type Admin = { coreLock: { ok: boolean; problems: string[] }; autopilot: unknown; doctor: unknown; stats: unknown };

export function Health() {
  const [h, setH] = useState<Health | null>(null); const [a, setA] = useState<Admin | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setH, (e) => setError(String(e.message)));
    api<Admin>('/api/admin/health').then(setA, (e) => setError(String(e.message)));
  }, []);
  if (error !== null) {
    return (
      <div className="flex flex-col gap-4">
        <PageTitle>Health</PageTitle>
        <Notice tone="danger">Could not load health: {error}. Ask your agent to run <code>mobrain status --detail</code>.</Notice>
      </div>
    );
  }
  if (!h || !a) return <Spinner />;
  return (
    <div className="flex flex-col gap-4">
      <PageTitle>Health</PageTitle>
      {h.ok && a.coreLock.ok ? <Notice tone="ok">Everything is running.</Notice> : <Notice tone="danger">Something needs attention. Ask your agent to run <code>mobrain status --detail</code>.</Notice>}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card title="Database"><Metric>{h.db ? 'up' : 'down'}</Metric></Card>
        <Card title="gbrain"><Metric>{h.gbrain ? 'up' : 'down'}</Metric></Card>
        <Card title="gbrain version"><Metric>{h.pin.running ?? '?'}</Metric>{!h.pin.matches && <Notice tone="warning">Pinned {h.pin.expected}</Notice>}</Card>
        <Card title="Core schema"><Metric>{a.coreLock.ok ? 'intact' : 'broken'}</Metric></Card>
      </div>
      <Card title="Autopilot"><pre className="overflow-x-auto text-sm">{JSON.stringify(a.autopilot, null, 2)}</pre></Card>
      <Card title="Brain stats"><pre className="overflow-x-auto text-sm">{JSON.stringify(a.stats, null, 2)}</pre></Card>
      <Card title="gbrain doctor"><pre className="max-h-96 overflow-auto text-sm">{JSON.stringify(a.doctor, null, 2)}</pre></Card>
    </div>
  );
}
