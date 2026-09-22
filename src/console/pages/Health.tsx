import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge, Card, Empty, Link, Notice, Table, TableWrap, toneClass } from '../ui/index.tsx';
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

export function Health() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    const load = () => api.get<Health>('/health').then(setHealth).catch(() => setHealth(null));
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  if (!health) return <Empty>Checking…</Empty>;

  const repos = health.repos ?? [];
  const alerts = health.scheduleAlerts ?? [];
  // `/api/health` only ever returns unacknowledged alerts, so "open" is implied
  // here; the Schedules page is where they are acknowledged.
  const pinned = alerts.filter((alert) => isPinnedAlert(alert.kind));

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Health</h1>
      <div>
        <Badge tone={health.ok ? 'ok' : 'danger'}>
          {health.ok ? 'All components healthy' : 'Degraded'}
        </Badge>
      </div>

      {/* Requirement 7: a schedule alert is pinned here too, above the probes.
          This endpoint carries alert KINDS only — no `detail`, because a
          push_blocked detail can name a path that matched a secret scan — so
          acknowledging happens on the Schedules page, where the alert is
          authenticated. */}
      {alerts.length > 0 && (
        // `layout="stack"` rather than the row shape plus a `w-full` wrapper:
        // this is a block of lines, not an icon beside one.
        <Notice layout="stack">
          <div className="font-medium">
            {alerts.length} open schedule alert{alerts.length === 1 ? '' : 's'}
          </div>
          {pinned.map((alert) => (
            <div key={alert.id}>
              {/* An alert label is a whole sentence, not a chip, so it stays
                  toned text rather than becoming a Badge. */}
              <span className={toneClass(alertTone(alert.kind))}>
                {alertLabel(alert.kind)}
              </span>
              <span className="text-xs text-muted font-mono">
                {' '}· {new Date(alert.at).toLocaleString()}
              </span>
            </div>
          ))}
          {alerts.length > pinned.length && (
            <div className="text-muted">
              {alerts.length - pinned.length} more, listed on the Schedules page.
            </div>
          )}
          {/* `surface="notice"`, which is why this link is underlined and
              inherits the notice's copy colour instead of going CTA blue:
              `--cta` is a dark navy that all but disappears against the dark
              theme's olive `--warn-surface`. The rule lives in `linkClass` now
              rather than as a bare `underline` nobody could see the reason
              for — `<a>` was the shape `buttonClass('link')` could never serve,
              since its `enabled:hover:` never matches an anchor. */}
          <Link surface="notice" href="/schedules">
            Open Schedules to acknowledge →
          </Link>
        </Notice>
      )}

      {/* No heading: the probe table is the page's opening statement and naming
          it would be new copy, which this restyle does not add. */}
      <Card>
        <TableWrap>
          <Table>
            <tbody>
              {Object.entries(health.components).map(([k, v]) => (
                <tr key={k}>
                  <td className="font-mono">{k}</td>
                  <td><Badge tone={v === 'ok' ? 'ok' : 'danger'}>{v}</Badge></td>
                </tr>
              ))}
              <tr>
                <td className="font-mono">gbrain</td>
                <td className="font-mono">{health.gbrainVersion ?? 'unknown'}</td>
              </tr>
            </tbody>
          </Table>
        </TableWrap>
      </Card>

      <Card title="Source repos">
        {repos.length === 0 ? (
          <Empty>No Source repos reported.</Empty>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>source</th>
                  <th>branch</th>
                  <th>lock</th>
                  <th>uncommitted</th>
                  <th>unpushed</th>
                </tr>
              </thead>
              <tbody>
                {repos.map((r) => (
                  <tr key={r.sourceId}>
                    <td className="font-mono">{r.sourceId}</td>
                    <td className="font-mono">{r.branch ?? '—'}</td>
                    <td>
                      <Badge tone={r.staleLock ? 'danger' : 'ok'}>
                        {r.staleLock ? `stale (${r.lockAgeSeconds ?? '?'}s)` : 'ok'}
                      </Badge>
                    </td>
                    {/* Counts stay plain numbers with a tone: a zero is not a
                        status worth a chip, and a chip around every cell would
                        make the one that matters harder to find, not easier. */}
                    <td className={r.uncommittedFiles > 0 ? 'text-warning' : ''}>
                      {r.uncommittedFiles}
                    </td>
                    <td className={r.unpushedCommits > 0 ? 'text-warning' : ''}>
                      {r.unpushedCommits}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      <p className="text-xs text-muted">Checked {new Date(health.at).toLocaleString()}</p>
    </div>
  );
}
