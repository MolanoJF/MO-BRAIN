import { useEffect, useState } from 'react';
import {
  api, upgradeApi, type DetectResult, type UpgradeRunRow, type UpgradeEventRow,
  type ChecklistItemRow, type DriftResult, type UpgradeRunDetail,
} from '../api.ts';

/**
 * The eight steps every run passes through, in order (Task 10's run state
 * machine). Kept LOCAL to the console on purpose: src/upgrade/state.ts pulls
 * in server-only modules (Postgres, node:fs), and this bundle ships to a
 * browser.
 */
export const UPGRADE_STEPS = [
  'plan', 'snapshot', 'quiesce', 'swap', 'migrate', 'playbooks', 'resume', 'verify',
] as const;

const STEP_LABEL: Record<string, string> = {
  plan: 'Plan', snapshot: 'Snapshot', quiesce: 'Quiesce', swap: 'Swap images',
  migrate: 'Apply migrations', playbooks: 'Playbooks', resume: 'Resume', verify: 'Verify (doctor)',
};

export function stepLabel(step: string): string {
  return STEP_LABEL[step] ?? step;
}

/**
 * Honesty rule 1: `check-update` never sets an exit code, so a network
 * failure is visible ONLY through `.error`. These branches read as two
 * unrelated facts, not two shades of the same one.
 */
export function bannerFor(detect: DetectResult | null): string {
  if (!detect) return 'Checking…';
  if (detect.error === 'network_error') return 'Could not check for an update — the network request failed.';
  if (detect.error === 'no_releases') return 'Could not check for an update — upstream has no release info.';
  if (detect.error === 'malformed_response') return 'Could not check for an update — the release check returned an unreadable answer.';
  if (!detect.update_available) return `Up to date at ${detect.current_version}.`;
  return `${detect.latest_version} is available (currently ${detect.current_version}).`;
}

export function stepStatus(events: UpgradeEventRow[], step: string): 'pending' | 'active' | 'done' | 'failed' {
  const has = (type: string) => events.some((e) => e.type === type && (e.data as { step?: string } | null)?.step === step);
  if (has('step_failed')) return 'failed';
  if (has('step_finished')) return 'done';
  if (has('step_started')) return 'active';
  return 'pending';
}

/** The step a failed run died on, or null for a run that never failed. */
export function failedStep(events: UpgradeEventRow[]): string | null {
  const ev = events.find((e) => e.type === 'step_failed');
  return ev ? String((ev.data as { step?: string } | null)?.step ?? 'unknown') : null;
}

export function rolledBack(run: UpgradeRunRow): boolean {
  return run.state === 'rolled_back';
}

export function runDuration(run: UpgradeRunRow): string {
  if (!run.finishedAt) return 'in progress';
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (ms < 0) return 'unknown';
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/**
 * "Nothing to compare" and "compared, identical" are different facts. Task 8
 * marks the first with `single_snapshot`; collapsing both into one string
 * would tell an operator "verified no drift" when only one side was ever
 * captured.
 */
export function driftText(drift: DriftResult | null): string {
  if (!drift) return 'Loading…';
  if (drift.signal === 'single_snapshot') {
    return `Nothing to compare yet — only one of ${drift.from} / ${drift.to} has a recorded capability snapshot.`;
  }
  if (drift.signal === 'no_drift') return `No capability drift between ${drift.from} and ${drift.to}.`;
  const d = drift.diff!;
  const parts: string[] = [];
  if (d.toolsAdded.length) parts.push(`+${d.toolsAdded.length} tools`);
  if (d.toolsRemoved.length) parts.push(`-${d.toolsRemoved.length} tools`);
  if (d.adaptersAdded.length) parts.push(`+${d.adaptersAdded.length} adapters`);
  if (d.adaptersRemoved.length) parts.push(`-${d.adaptersRemoved.length} adapters`);
  if (d.profilesChanged) parts.push('profiles changed');
  return parts.length > 0 ? `Drift: ${parts.join(', ')}.` : `Drift recorded between ${drift.from} and ${drift.to}.`;
}

/**
 * Honesty rule 8: an undecided item keeps the banner up until a human acts.
 * The checklist table's stored vocabulary is Task 3's
 * (`pending | acknowledged | declined`, schema.ts:415) — a freshly opened item
 * is `pending`. `awaiting_admin_decision` is a RUN and playbook_ledger state,
 * never a checklist-item state, so it must not be treated as one here.
 */
export function pendingChecklist(items: ChecklistItemRow[]): ChecklistItemRow[] {
  return items.filter((i) => i.state === 'pending');
}

/** The exact host command this page names in place of a "start" button (D1). */
export function planCommand(toVersion: string): string {
  return `bun run scripts/upgrade.ts plan --to ${toVersion}`;
}
export function runCommand(toVersion: string): string {
  return `bun run scripts/upgrade.ts run --to ${toVersion}`;
}

export function Upgrades() {
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [runs, setRuns] = useState<UpgradeRunRow[]>([]);
  const [openRun, setOpenRun] = useState<UpgradeRunDetail | null>(null);
  const [drift, setDrift] = useState<DriftResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [d, r] = await Promise.all([
      upgradeApi.available().catch((): DetectResult => ({
        current_version: '', latest_version: '', update_available: false,
        changelog_diff: '', release_url: '', error: 'network_error',
      })),
      upgradeApi.list(),
    ]);
    setDetect(d);
    setRuns(r.runs);
    const latest = r.runs[0];
    if (latest) {
      const detail = await upgradeApi.detail(latest.id).catch(() => null);
      if (detail) setOpenRun(detail);
      const dr = await upgradeApi.drift(latest.fromVersion, latest.toVersion).catch(() => null);
      if (dr) setDrift(dr);
    }
    setError(null);
  };

  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : 'Load failed')); }, []);
  useEffect(() => {
    const t = setInterval(() => { void load().catch(() => { /* the next poll retries */ }); }, 15_000);
    return () => clearInterval(t);
  }, []);

  const decide = (itemId: string, decision: 'ack' | 'decline') => async () => {
    setBusy(true);
    try {
      await (decision === 'ack' ? upgradeApi.ack(itemId) : upgradeApi.decline(itemId));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record the decision');
    } finally {
      setBusy(false);
    }
  };

  const target = detect && !detect.error && detect.update_available ? detect.latest_version : '<version>';

  return (
    <div className="max-w-3xl space-y-6">
      <header><h1 className="text-xl font-semibold">Upgrades</h1></header>

      {error && <div className="text-danger text-sm">{error}</div>}

      <section className="card space-y-2">
        <div className={detect?.error ? 'text-warning' : 'text-sm'}>{bannerFor(detect)}</div>
        {detect && !detect.error && detect.update_available && detect.changelog_diff && (
          <pre className="text-xs text-muted whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
            {detect.changelog_diff}
          </pre>
        )}
      </section>

      <section className="card space-y-2">
        <h2 className="text-lg font-semibold">Runs</h2>
        {runs.length === 0 ? <p className="text-sm text-muted">No upgrade has run yet.</p> : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-subtle text-left">
                <th className="py-2 pr-3">version</th>
                <th className="py-2 pr-3">state</th>
                <th className="py-2 pr-3">duration</th>
                <th className="py-2">snapshot</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-subtle">
                  <td className="py-2 pr-3 font-mono">{r.fromVersion} → {r.toVersion}</td>
                  <td className="py-2 pr-3">{r.state}{rolledBack(r) ? ' (rolled back)' : ''}</td>
                  <td className="py-2 pr-3">{runDuration(r)}</td>
                  <td className="py-2 font-mono text-xs">{r.snapshotId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {openRun && (
          <div className="pt-2 space-y-1">
            <div className="text-sm text-muted">
              Steps for {openRun.run.fromVersion} → {openRun.run.toVersion}
            </div>
            <div className="flex gap-2 flex-wrap">
              {UPGRADE_STEPS.map((step) => {
                const status = stepStatus(openRun.events, step);
                const tone = status === 'failed' ? 'text-danger'
                  : status === 'done' ? 'text-ok'
                  : status === 'active' ? 'text-warning' : 'text-muted';
                return <span key={step} className={`text-xs ${tone}`}>{stepLabel(step)}</span>;
              })}
            </div>
            {failedStep(openRun.events) && (
              <div className="text-sm text-danger">
                Failed at: {stepLabel(failedStep(openRun.events)!)}
                {rolledBack(openRun.run) ? ' — rolled back.' : ' — not rolled back.'}
              </div>
            )}
          </div>
        )}
      </section>

      {openRun && pendingChecklist(openRun.checklist).length > 0 && (
        <section className="card border-warning space-y-3">
          <h2 className="text-lg font-semibold text-warning">Awaiting your decision</h2>
          <p className="text-xs text-muted">
            These persist until acknowledged or declined and block nothing else while they wait.
          </p>
          {pendingChecklist(openRun.checklist).map((item) => (
            <div key={item.id} className="border-b border-subtle pb-2 space-y-1">
              <div className="font-medium">{item.prompt}</div>
              <div className="text-sm text-muted">{item.why}</div>
              <div className="flex gap-2">
                <button disabled={busy} className="nav-item" onClick={decide(item.id, 'ack')}>Acknowledge</button>
                <button disabled={busy} className="nav-item" onClick={decide(item.id, 'decline')}>Decline</button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="card space-y-1">
        <h2 className="text-lg font-semibold">Capability drift</h2>
        <div className="text-sm">{driftText(drift)}</div>
      </section>

      <section className="card space-y-2">
        <h2 className="text-lg font-semibold">Starting an upgrade</h2>
        <p className="text-sm text-muted">
          Upgrades run on the Docker host, not from this console — the control plane holds no Docker
          socket and cannot swap images or quiesce services. That is a privilege boundary, not a
          missing feature. Run it from the host:
        </p>
        <pre className="text-xs font-mono bg-subtle p-2 rounded">
          {planCommand(target)}{'\n'}{runCommand(target)}
        </pre>
      </section>
    </div>
  );
}
