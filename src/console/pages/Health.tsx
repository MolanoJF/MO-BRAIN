import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { alertLabel, alertTone, isPinnedAlert } from './Schedules.tsx';

type RepoStatus = {
  sourceId: string;
  staleLock: boolean;
  lockAgeSeconds: number | null;
  uncommittedFiles: number;
  unpushedCommits: number;
  branch: string | null;
};

/** `/api/health` is the unauthenticated healthcheck: kinds and counts only. */
type HealthAlert = { id: string; kind: string; scheduleId: string | null; at: string };

type Health = {
  ok: boolean; components: Record<string, string>;
  gbrainVersion: string | null; repos?: RepoStatus[]; scheduleAlerts?: HealthAlert[];
  at: string;
};

const TONE_CLASS: Record<string, string> = {
  ok: 'text-ok', warning: 'text-warning', danger: 'text-danger', muted: 'text-muted',
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

  const repos = health.repos ?? [];
  const alerts = health.scheduleAlerts ?? [];
  // `/api/health` only ever returns unacknowledged alerts, so "open" is implied
  // here; the Schedules page is where they are acknowledged.
  const pinned = alerts.filter((alert) => isPinnedAlert(alert.kind));

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Health</h1>
      <div className={health.ok ? 'text-ok' : 'text-danger'}>
        {health.ok ? 'All components healthy' : 'Degraded'}
      </div>

      {/* Requirement 7: a schedule alert is pinned here too, above the probes.
          This endpoint carries alert KINDS only — no `detail`, because a
          push_blocked detail can name a path that matched a secret scan — so
          acknowledging happens on the Schedules page, where the alert is
          authenticated. */}
      {alerts.length > 0 && (
        <section className="card border-warning space-y-2">
          <div className="font-medium text-warning">
            {alerts.length} open schedule alert{alerts.length === 1 ? '' : 's'}
          </div>
          {pinned.map((alert) => (
            <div key={alert.id} className="text-sm">
              <span className={TONE_CLASS[alertTone(alert.kind)] ?? 'text-warning'}>
                {alertLabel(alert.kind)}
              </span>
              <span className="text-xs text-muted font-mono">
                {' '}· {new Date(alert.at).toLocaleString()}
              </span>
            </div>
          ))}
          {alerts.length > pinned.length && (
            <div className="text-sm text-muted">
              {alerts.length - pinned.length} more, listed on the Schedules page.
            </div>
          )}
          <a className="text-sm" href="/schedules">Open Schedules to acknowledge →</a>
        </section>
      )}
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
      <h2 className="text-lg font-semibold">Space repos</h2>
      {repos.length === 0 ? (
        <p className="text-sm text-muted">No Space repos reported.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-subtle text-left">
              <th className="py-2 pr-3">source</th>
              <th className="py-2 pr-3">branch</th>
              <th className="py-2 pr-3">lock</th>
              <th className="py-2 pr-3">uncommitted</th>
              <th className="py-2">unpushed</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((r) => (
              <tr key={r.sourceId} className="border-b border-subtle">
                <td className="py-2 pr-3 font-mono">{r.sourceId}</td>
                <td className="py-2 pr-3 font-mono">{r.branch ?? '—'}</td>
                <td className={`py-2 pr-3 ${r.staleLock ? 'text-danger' : 'text-ok'}`}>
                  {r.staleLock ? `stale (${r.lockAgeSeconds ?? '?'}s)` : 'ok'}
                </td>
                <td className={`py-2 pr-3 ${r.uncommittedFiles > 0 ? 'text-warning' : ''}`}>
                  {r.uncommittedFiles}
                </td>
                <td className={r.unpushedCommits > 0 ? 'text-warning' : ''}>{r.unpushedCommits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-muted">Checked {new Date(health.at).toLocaleString()}</p>
    </div>
  );
}
