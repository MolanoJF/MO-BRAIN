import { useEffect, useState } from 'react';
import {
  api, upgradeApi, type DetectResult, type UpgradeRunRow, type UpgradeEventRow,
  type ChecklistItemRow, type DriftResult, type UpgradeRunDetail,
} from '../api.ts';
import { Badge, Button, Card, Empty, Notice, PageTitle, Table, TableWrap, type Tone } from '../ui/index.tsx';

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

export type StepStatus = 'pending' | 'active' | 'done' | 'failed';

export function stepStatus(events: UpgradeEventRow[], step: string): StepStatus {
  const has = (type: string) => events.some((e) => e.type === type && (e.data as { step?: string } | null)?.step === step);
  if (has('step_failed')) return 'failed';
  if (has('step_finished')) return 'done';
  if (has('step_started')) return 'active';
  return 'pending';
}

/**
 * The colour each step chip carries. This lived inline in the step row until
 * the chips became `Badge`s; it is exported because it is an operator-observable
 * decision — a failed step that renders in the same colour as a finished one is
 * a lie an operator would act on — and this console tests such decisions as
 * pure functions rather than through a DOM harness it does not have.
 *
 * `active` is `warning` rather than something calmer for the same reason qm
 * ambers an in-flight step: a swap or a migration that is still running is the
 * one state where interrupting the host actually breaks something.
 */
export function stepTone(status: StepStatus): Tone {
  switch (status) {
    case 'failed': return 'danger';
    case 'done': return 'ok';
    case 'active': return 'warning';
    case 'pending': return 'muted';
  }
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

/** Printed by the host lane and named here because the console cannot start containers. */
export const RESUME_WRITERS_COMMAND = 'bun run scripts/upgrade.ts resume-writers --run';

export function writersHeld(events: UpgradeEventRow[]): boolean {
  return events.some((e) => {
    const data = e.data;
    return !!data && typeof data === 'object' && (data as { writers?: string }).writers === 'held';
  });
}

/**
 * A pending checklist used to block nothing. A blocksResume hold leaves four
 * writers down, and Acknowledge/Decline in this page do not run resume-writers.
 */
export function checklistNotice(runId: string, events: UpgradeEventRow[]): string {
  if (!writersHeld(events)) {
    return 'These persist until acknowledged or declined and block nothing else while they wait.';
  }
  return (
    'Writers are held. agent-runner, scheduler, gbrain-worker, and gbrain-serve stay down until ' +
    `you run \`${RESUME_WRITERS_COMMAND} ${runId}\` on the host. Acknowledge and Decline here do not ` +
    'start them. Decline does not settle a hold when the item has no opt-out.'
  );
}

type JournalChecklistItem = { key?: string; blocksResume?: boolean; declineOp?: unknown };

function journalChecklist(events: UpgradeEventRow[]): JournalChecklistItem[] {
  const out: JournalChecklistItem[] = [];
  for (const event of events) {
    const data = event.data as { checklist?: unknown } | null;
    if (!data || !Array.isArray(data.checklist)) continue;
    for (const raw of data.checklist) {
      if (raw && typeof raw === 'object') out.push(raw as JournalChecklistItem);
    }
  }
  return out;
}

/** Decline records the decision and still leaves writers down when there is no opt-out. */
export function declineDoesNotSettle(events: UpgradeEventRow[], itemKey: string): boolean {
  return journalChecklist(events).some((item) =>
    item.key === itemKey && item.blocksResume === true && item.declineOp == null);
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
      <header><PageTitle>Upgrades</PageTitle></header>

      {error && <div className="text-[length:var(--control-font)] text-danger">{error}</div>}

      <Card>
        <div className={`text-[length:var(--control-font)] ${detect?.error ? 'text-warning' : ''}`}>
          {bannerFor(detect)}
        </div>
        {detect && !detect.error && detect.update_available && detect.changelog_diff && (
          <pre className="mt-2 text-xs text-muted whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
            {detect.changelog_diff}
          </pre>
        )}
      </Card>

      <Card title="Runs">
        {runs.length === 0 ? <Empty>No upgrade has run yet.</Empty> : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>version</th>
                  <th>state</th>
                  <th>duration</th>
                  <th>snapshot</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono">{r.fromVersion} → {r.toVersion}</td>
                    {/* Deliberately not a Badge: a run state carries no tone in
                        this console, and inventing one here would colour
                        `rolled_back` as either a success or a failure when the
                        page's whole position is that it is neither. */}
                    <td>{r.state}{rolledBack(r) ? ' (rolled back)' : ''}</td>
                    <td>{runDuration(r)}</td>
                    <td className="font-mono text-xs">{r.snapshotId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}

        {openRun && (
          <div className="pt-4 space-y-2">
            <div className="text-[length:var(--control-font)] text-muted">
              Steps for {openRun.run.fromVersion} → {openRun.run.toVersion}
            </div>
            <div className="flex gap-2 flex-wrap">
              {UPGRADE_STEPS.map((step) => (
                <Badge key={step} tone={stepTone(stepStatus(openRun.events, step))}>
                  {stepLabel(step)}
                </Badge>
              ))}
            </div>
            {failedStep(openRun.events) && (
              <div className="text-[length:var(--control-font)] text-danger">
                Failed at: {stepLabel(failedStep(openRun.events)!)}
                {rolledBack(openRun.run) ? ' — rolled back.' : ' — not rolled back.'}
              </div>
            )}
          </div>
        )}
      </Card>

      {openRun && pendingChecklist(openRun.checklist).length > 0 && (
        <Notice layout="stack">
          <h2 className="m-0 text-[length:var(--section-font)] font-medium">Awaiting your decision</h2>
          <p className="text-xs">
            {checklistNotice(openRun.run.id, openRun.events)}
          </p>
          {/* `w-full` on the row, not on a wrapper around the whole list. The
              stack gives each child `fit-content`, which is the full width for a
              paragraph but only the longest line for a box — and this box draws
              a rule under itself. A divider that stops where the shortest item's
              text stops reads as a ragged edge rather than as a separator, so
              the row asks for the width it needs. It is not a click target, so
              the blockifying that `items-stretch` is avoided for costs nothing
              here. */}
          {pendingChecklist(openRun.checklist).map((item) => (
            <div key={item.id} className="w-full border-b border-warn-border pb-2 space-y-1">
              <div className="font-medium">{item.prompt}</div>
              <div>{item.why}</div>
              <div className="flex gap-2">
                <Button disabled={busy} onClick={decide(item.id, 'ack')}>Acknowledge</Button>
                <Button disabled={busy} onClick={decide(item.id, 'decline')}>Decline</Button>
              </div>
              {declineDoesNotSettle(openRun.events, item.itemKey) && (
                <div>
                  Decline records the decision and does not settle this hold. Writers stay down until it is acknowledged.
                </div>
              )}
            </div>
          ))}
        </Notice>
      )}

      <Card title="Capability drift">
        <div className="text-[length:var(--control-font)]">{driftText(drift)}</div>
      </Card>

      <Card
        title="Starting an upgrade"
        subtitle={
          <>
            Upgrades run on the Docker host, not from this console — the control plane holds no Docker
            socket and cannot swap images or quiesce services. That is a privilege boundary, not a
            missing feature. Run it from the host:
          </>
        }
      >
        <pre className="text-xs font-mono bg-subtle p-2 rounded-[var(--control-radius)]">
          {planCommand(target)}{'\n'}{runCommand(target)}
        </pre>
      </Card>
    </div>
  );
}
