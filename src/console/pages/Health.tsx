import { useEffect, useState } from 'react';
import { api } from '../api.ts';

type Health = {
  ok: boolean; components: Record<string, string>;
  gbrainVersion: string | null; at: string;
};

export function Health() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    const load = () => api.get<Health>('/health').then(setHealth).catch(() => setHealth(null));
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  if (!health) return <div className="text-muted">Checking…</div>;

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Health</h1>
      <div className={health.ok ? 'text-ok' : 'text-danger'}>
        {health.ok ? 'All components healthy' : 'Degraded'}
      </div>
      <table className="w-full text-sm">
        <tbody>
          {Object.entries(health.components).map(([k, v]) => (
            <tr key={k} className="border-b border-subtle">
              <td className="py-2 font-mono">{k}</td>
              <td className={v === 'ok' ? 'text-ok' : 'text-danger'}>{v}</td>
            </tr>
          ))}
          <tr><td className="py-2 font-mono">gbrain</td>
              <td className="font-mono">{health.gbrainVersion ?? 'unknown'}</td></tr>
        </tbody>
      </table>
      <p className="text-xs text-muted">Checked {new Date(health.at).toLocaleString()}</p>
    </div>
  );
}
