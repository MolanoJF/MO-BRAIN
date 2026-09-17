/**
 * The agent lane's alert kinds, and the one place an agent alert is written.
 *
 * `schedule_alerts.kind` is free text with no CHECK constraint, so a new kind
 * needs no migration — and that freedom is exactly why the strings live here.
 * The console registers kinds BY HAND in four tables in
 * `src/console/pages/Schedules.tsx`, and an unregistered kind falls through to
 * the `warning` tone with a de-underscored label: a budget cap that stopped a
 * run would render as "agent budget exceeded" beside a push that merely
 * queued. `test/unit/console-schedules.test.ts` therefore asserts every kind
 * this module can emit is registered, so adding one here and forgetting it
 * there is a failing test rather than a quiet shrug.
 *
 * Task 6 (the finish and reclaim paths) and Task 7 (the meter) call
 * `raiseAgentAlert`; nothing writes these kinds inline.
 *
 * Authorship note for the integrator: `src/gateway/meter.ts` currently passes
 * its kind as a string through `RunFailureMark.alertKind` and inserts the row
 * itself. It is Task 7's file, so it was not touched here — it emits exactly
 * `AGENT_ALERT_KINDS.budgetExceeded`, and should call this helper instead.
 *
 * Honesty rules 4, 5, 8 and 10 are the reasons four of the five exist: a cap
 * that stops the run after the money is spent is not a cap; a dead runner's run
 * is not a finished run; "the runner is enabled" is not "the runner is
 * connected"; and a read Space that moved under a run is a finding, not a diff
 * row.
 */
import { randomUUID } from 'node:crypto';
import { getDb, schema } from '../control/db/client.ts';

export const AGENT_ALERT_KINDS = {
  /** D7's meter refused: honesty rule 4. D11: never retried, always alerted. */
  budgetExceeded: 'agent_budget_exceeded',
  /** D11's `agent_failed` — a non-zero exit or error frames in the stream. */
  runFailed: 'agent_run_failed',
  /** Honesty rule 10: read isolation broke under a run. Org-level (`scheduleId: null`). */
  readSpaceMoved: 'agent_read_space_moved',
  /**
   * D12 / honesty rule 8: an agent schedule exists and no runner ever claimed.
   * Org-level: the finding is about the deployment, not the schedule.
   */
  runnerNeverSeen: 'runner_never_seen',
  /**
   * The runner's own pin did not match the schedule's, so it refused the claim.
   * Org-level: the mismatch is between two deployments' pins.
   */
  harnessPinMismatch: 'harness_pin_mismatch',
} as const;

export type AgentAlertKind = (typeof AGENT_ALERT_KINDS)[keyof typeof AGENT_ALERT_KINDS];

export type AgentAlertInput = {
  organizationId: string;
  /** null for a deployment-level kind, and for a schedule that no longer exists. */
  scheduleId: string | null;
  /** The run this is about, when there is one. */
  runId?: string | null;
  kind: AgentAlertKind;
  /** S3c: reason codes, ids, counts and names — never a model request body. */
  detail?: Record<string, unknown> | null;
};

/**
 * Write one agent alert. Not deduplicated on purpose: the dedupe belongs to the
 * caller that can see the previous state (Task 7's meter collapses its repeated
 * refusals into one row per run, because the first refusal is the event and the
 * rest are the same fact restated). A retry's second failure is a different
 * run and deserves its own row.
 */
export async function raiseAgentAlert(alert: AgentAlertInput): Promise<void> {
  await getDb().insert(schema.scheduleAlerts).values({
    id: randomUUID(),
    organizationId: alert.organizationId,
    scheduleId: alert.scheduleId,
    runId: alert.runId ?? null,
    kind: alert.kind,
    detail: alert.detail ?? null,
  });
}
