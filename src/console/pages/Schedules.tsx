import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError, api, scheduleApi,
  type AlertRow, type CreateScheduleBody, type PresetRow, type RunRow,
  type ScheduleRow, type ScheduleSettings,
} from '../api.ts';
import { SCHEDULER_COMMANDS } from '../../scheduler/commands.ts';
import { snapToSlot, footprintsCollide } from '../../scheduler/stagger.ts';
import { MODEL_PRICING, PRICED_AT, rateFor } from '../../gateway/pricing.ts';

/* -------------------------------------------------------------------------
 * Pure helpers. Exported so test/unit/console-schedules.test.ts can assert the
 * copy and the invariants without a DOM server — the honesty rules are strings
 * the operator reads, so they are testable state, not decoration.
 * ---------------------------------------------------------------------- */

export type Tone = 'ok' | 'warning' | 'danger' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-ok', warning: 'text-warning', danger: 'text-danger', muted: 'text-muted',
};

/**
 * Mirrors ROLE_RANK in src/control/rbac.ts. The console must not import that
 * module: it pulls the auth/db stack into the browser bundle.
 */
const ADMIN_RANK = 2;
const RANK: Record<string, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export type CommandScope = 'source' | 'brain-wide' | 'agent';

/**
 * Honesty rule 1, in the operator's words. The scope is a control-plane argv
 * fence, NOT an OAuth scope gbrain enforces: these commands are absent from
 * gbrain's MCP operation registry and run as gbrain-ops's local admin identity.
 */
export const CONTROL_LANE_DISCLOSURE =
  "Scheduled commands run on gbrain's control lane as the ops service account. "
  + 'The Connection you pick decides which Space is synced, where the report is written, '
  + "and whose name is on the commit — it is not a permission gbrain enforces for these commands.";

/**
 * D12's plain words, for the OTHER lane. An agent run does not go through the
 * ops service account and is not a command at all, so the disclosure above would
 * be a lie here: it is a model-written run, executed by the runner, spending the
 * organization's budget with nobody watching.
 */
export const AGENT_LANE_DISCLOSURE =
  'An agent schedule hands this prompt to the runner, which runs the pinned Claude Code harness '
  + "against your brain with your organization's API key. It can call only the gbrain tools your "
  + 'Connection is allowed — no shell, no file writes, no other network — and every run costs real '
  + 'money against a per-run budget, with nobody watching it.';

/** Mirrors `PresetAgent` in src/scheduler/presets.ts without importing it. */
export type AgentPayload = {
  prompt: string;
  model: string;
  maxTokens: number;
  /** Text, like the column: money never becomes a float. */
  budgetUsd: string;
};

/**
 * The preset as the API actually sends it: `PresetRow` (src/console/api.ts) plus
 * the agent lane's two fields, which that type does not declare yet. Structural
 * rather than imported for the same reason `RANK` mirrors `ROLE_RANK` by hand —
 * the console must not pull the scheduler's db stack into the browser bundle.
 */
export type PresetShape = {
  operation?: string | null;
  jobType?: string;
  agent?: AgentPayload;
};

/** The scheduler allowlist is the single source of truth for scope. */
export function commandScope(operation: string | null | undefined): CommandScope | null {
  if (!operation) return null;
  return SCHEDULER_COMMANDS[operation]?.scope ?? null;
}

/**
 * The two internal drains run no gbrain command at all, so they read no brain
 * and are fenceable like any source-scoped job. The agent lane is its own scope:
 * it runs a model, not a command, and its banner says so.
 */
export function presetScope(preset: PresetShape): CommandScope {
  if (preset.jobType === 'agent_prompt') return 'agent';
  return commandScope(preset.operation ?? null) ?? 'source';
}

/**
 * The agent run a preset buys, or null when the preset is a command. The preset
 * is the DEFAULT the form is pre-filled with (D3), and the harness pin is
 * derived at creation.
 */
export function agentPayloadOf(preset: PresetShape | null | undefined): AgentPayload | null {
  return preset && preset.jobType === 'agent_prompt' && preset.agent ? preset.agent : null;
}

/* -------------------------------------------------------------------------
 * D3: the agent payload is the operator's, not just the preset's.
 *
 * The four fields the route accepts (`AGENT_CREATE_KEYS` in
 * `src/control/routes/schedules.ts`) are editable here, pre-filled from the
 * preset so a one-click create still works. The model picker reads the SHIPPED
 * pinned table itself — `src/gateway/pricing.ts` is pure data with no imports,
 * so importing it costs the bundle nothing and there is no hand-copied mirror to
 * drift from the pin. Every refusal below is the route's own sentence, in the
 * route's own words, so the form never invents a second vocabulary.
 * ---------------------------------------------------------------------- */

/** The models the pinned table prices, in the table's own order. */
export const PRICED_MODELS: string[] = Object.keys(MODEL_PRICING.models);

/**
 * Mirrors the route's own bounds (`AGENT_PROMPT_MAX_CHARS`,
 * `AGENT_MAX_TOKENS_MIN/MAX`, `AGENT_BUDGET_MAX_USD`, `AGENT_BUDGET_RE`). They
 * are mirrored rather than imported for the reason `RANK` mirrors `ROLE_RANK`:
 * the route module pulls the control DB stack, which must not reach the bundle.
 */
export const AGENT_PROMPT_MAX_CHARS = 4000;
export const AGENT_MAX_TOKENS_MIN = 256;
export const AGENT_MAX_TOKENS_MAX = 64_000;
export const AGENT_BUDGET_MAX_USD = 100;
const AGENT_BUDGET_RE = /^\d+(\.\d{1,6})?$/;

/** The form's own draft of the payload: numbers and money arrive as text. */
export type AgentDraft = {
  prompt: string;
  model: string;
  maxTokens: string;
  budgetUsd: string;
};

/** The preset's payload as a form draft — the default the form opens on. */
export function agentDraftOf(payload: AgentPayload): AgentDraft {
  return {
    prompt: payload.prompt,
    model: payload.model,
    maxTokens: String(payload.maxTokens),
    budgetUsd: payload.budgetUsd,
  };
}

/**
 * The route's `intOf`, kept whole: an integer string is a number, and anything
 * else — including `12.5`, `1e3` and `''` — is not an integer.
 */
function intOf(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : null;
}

export type AgentRefusal = { field: string; detail: string };

/**
 * What the route would refuse about this draft, in the route's own words. The
 * form refuses it first, so an operator never learns the shape of the payload
 * from a 400 — and the two can never disagree about the bounds.
 */
export function agentFormRefusals(draft: AgentDraft): AgentRefusal[] {
  const refusals: AgentRefusal[] = [];

  if (draft.prompt.trim() === '' || draft.prompt.length > AGENT_PROMPT_MAX_CHARS) {
    refusals.push({
      field: 'agentPrompt',
      detail: `a non-empty prompt of at most ${AGENT_PROMPT_MAX_CHARS} characters — a pointer `
        + 'at what to do, not an inlined essay',
    });
  }

  if (draft.model === '' || rateFor(draft.model) === null) {
    refusals.push({
      field: 'agentModel',
      detail: `Not in the price table pinned on ${PRICED_AT}, so a run on it `
        + 'would have an unknowable cost. Pick a priced model.',
    });
  }

  const maxTokens = intOf(draft.maxTokens);
  if (maxTokens === null || maxTokens < AGENT_MAX_TOKENS_MIN || maxTokens > AGENT_MAX_TOKENS_MAX) {
    refusals.push({
      field: 'agentMaxTokens',
      detail: `an integer in [${AGENT_MAX_TOKENS_MIN}, ${AGENT_MAX_TOKENS_MAX}]`,
    });
  }

  if (!AGENT_BUDGET_RE.test(draft.budgetUsd) || !(Number(draft.budgetUsd) > 0)
    || Number(draft.budgetUsd) > AGENT_BUDGET_MAX_USD) {
    refusals.push({
      field: 'agentBudgetUsd',
      detail: `a decimal greater than 0 and at most ${AGENT_BUDGET_MAX_USD} USD, `
        + 'with at most six decimal places',
    });
  }

  return refusals;
}

/** The four keys the create body carries, normalized the way the route does. */
export function agentCreateFields(draft: AgentDraft): Required<Pick<
  CreateScheduleBody, 'agentPrompt' | 'agentModel' | 'agentMaxTokens' | 'agentBudgetUsd'
>> {
  return {
    agentPrompt: draft.prompt,
    agentModel: draft.model,
    agentMaxTokens: intOf(draft.maxTokens) ?? 0,
    agentBudgetUsd: draft.budgetUsd,
  };
}

/**
 * D9 — the Connection line and its member's role, said ONCE. The old rendering
 * appended the label "member" to the role's own value, so a member Connection
 * read "— member member"; the label is now the word the value is not.
 */
export function memberRoleLine(role: string | null | undefined): string {
  return `member role: ${role && role !== '' ? role : 'unknown'}`;
}

/* -------------------------------------------------------------------------
 * D5: two clocks for one occurrence, both labelled.
 *
 * The ledger shows the scheduler's `slot` — the ORG-local wall clock the job was
 * materialized for — and the absolute `fire_at` instant. Rendering the second in
 * the viewer's own zone is useful and must stay; rendering it unlabelled beside
 * the first is what made two correct numbers read as a disagreement. So both are
 * named, and the viewer's zone with them (the discipline `quietHoursBadge`
 * already follows for the org's).
 * ---------------------------------------------------------------------- */

/** The viewer's IANA zone, or null where the browser will not say. */
function viewerZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone !== '' ? zone : null;
  } catch {
    return null;
  }
}

/**
 * One occurrence, two labelled clocks. `slot` is the org-local wall clock the
 * scheduler materialized the run for; `fireAt` is the same instant, which is
 * only readable in the viewer's zone. Passing `zone` explicitly is what makes
 * the wording testable without a browser locale.
 */
export function slotClocks(
  slot: string,
  fireAt: string,
  zone: string | null | undefined = undefined,
): { org: string; viewer: string } {
  const tz = zone === undefined ? viewerZone() : zone;
  return {
    org: `org clock ${slot}`,
    viewer: `your clock ${new Date(fireAt).toLocaleString()}${tz === null || tz === '' ? '' : ` (${tz})`}`,
  };
}

/**
 * Honesty rule 2: a brain-wide command cannot be fenced to a Space. Picking one
 * swaps the disclosure for the whole-brain warning rather than adding to it. An
 * agent run is fenceable (its tools come from the Connection), so it keeps its
 * own disclosure and names the Space it can reach.
 */
export function bannerFor(input: { scope?: string | null; writeSpace?: string | null }): string {
  if (input.scope === 'agent') {
    return `${AGENT_LANE_DISCLOSURE} The Connection you pick decides which Space it can `
      + `reach — ${input.writeSpace || 'no Space'} — and whose name is on the commit.`;
  }
  if (input.scope === 'source') return CONTROL_LANE_DISCLOSURE;
  const space = input.writeSpace;
  const tail = "gbrain's control lane cannot fence a brain-wide command to a Space, so it needs "
    + 'a Connection whose member is admin-or-better.';
  return space
    ? `This job reads the whole brain, not just ${space}. ${tail}`
    : `This job reads the whole brain — there is no Space it can be fenced to. ${tail}`;
}

/** Requirement 3: confirm is disabled unless the Connection's member is admin+. */
export function confirmBlockedFor(
  input: { scope?: string | null; memberRole?: string | null },
): boolean {
  // The agent lane needs no admin: its tool surface is the Connection's own
  // compiled scoping. The brain-wide lane is the one that reads everything.
  if (input.scope === 'source' || input.scope === 'agent') return false;
  if (input.scope === 'brain-wide') {
    return (RANK[input.memberRole ?? ''] ?? 0) < ADMIN_RANK;
  }
  // A scope we do not recognise is never assumed fenceable.
  return true;
}

/** Requirement 1: a schedule belongs to a Connection, never to a Member. */
export function connectionLine(
  connection: { clientName?: string | null; writeSpace?: string | null } | null,
): string {
  if (!connection) return 'no Connection — this schedule cannot run';
  return `runs as ${connection.clientName || 'an unnamed client'} · `
    + `writes to ${connection.writeSpace || 'no Space'}`;
}

export function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export type SlotRefusal = {
  error?: string;
  nextFree: number | null;
  /** The wall time the operator asked for — the 409 body does not carry it. */
  requested: { hour: number; minute: number };
};

/** Requirement 4: a conflict is a choice with both times named, never an error. */
export function conflictMessage(refusal: SlotRefusal, holder: string): string {
  const taken = hhmm(refusal.requested.hour, refusal.requested.minute);
  const head = `${taken} is taken by ${holder}.`;
  const hour = refusal.requested.hour;
  return refusal.nextFree === null
    ? `${head} No free slot left in ${hhmm(hour, 0)}–${hhmm(hour, 50)}.`
    : `${head} Next free: ${hhmm(hour, refusal.nextFree)}`;
}

export type SlotFootprintInput = {
  name?: string;
  kind?: string;
  calendarHour?: number | null;
  calendarMinute?: number | null;
  calendarDaysOfWeek?: number[] | null;
  slotMinute?: number | null;
};

/**
 * Which enabled calendar schedule occupies the slot the operator asked for. The
 * 409 body carries only `nextFree`, so the holder is found here instead of
 * being guessed from the refusal.
 */
export function slotHolder(
  schedules: SlotFootprintInput[],
  requested: { hour: number; minute: number; daysOfWeek?: number[] | null },
  exceptName?: string,
): string | null {
  const wanted = snapToSlot(requested.minute);
  const hit = schedules.find((s) => {
    if (s.kind !== 'calendar') return false;
    if (exceptName !== undefined && s.name === exceptName) return false;
    return footprintsCollide(
      { slotMinute: wanted, hour: requested.hour, daysOfWeek: requested.daysOfWeek ?? null },
      {
        slotMinute: s.slotMinute ?? snapToSlot(s.calendarMinute ?? 0),
        hour: s.calendarHour ?? -1,
        daysOfWeek: s.calendarDaysOfWeek ?? null,
      },
    );
  });
  return hit?.name ?? null;
}

/** Requirement 5: the one-click fix needs the holder's id, not just its name. */
export function laneHolderId(
  schedules: { id: string; name: string }[],
  holderName: string | null | undefined,
): string | null {
  if (!holderName) return null;
  return schedules.find((s) => s.name === holderName)?.id ?? null;
}

/**
 * Requirement 5: the sub-hourly cap is upstream's "don't over-cron" made
 * structural — a sub-hourly job occupies every stagger slot, so a second one
 * cannot be staggered against the first.
 */
export function subHourlyMessage(
  refusal: { error?: string; holder?: string | null; detail?: string | null },
): string {
  const holder = refusal.holder || 'another schedule';
  const detail = (refusal.detail ?? '').trim()
    || 'A sub-hourly schedule occupies every 5-minute stagger slot, so a second one cannot be '
      + 'staggered against it.';
  // The server's `detail` already carries the remedy; do not say it twice.
  const remedy = /hour or more/i.test(detail)
    ? ''
    : ' Give this one an interval of an hour or more, or disable the schedule holding the lane.';
  return `${holder} already holds the sub-hourly lane. ${detail}${remedy}`;
}

const RUN_LABEL: Record<string, string> = {
  pending: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  blocked: 'Blocked by gbrain',
  cancelled: 'Cancelled',
  lease_expired: 'Lease expired',
  skipped_overlap: 'Skipped — another run in flight',
  skipped_catchup: 'Skipped — missed while the scheduler was down',
  held: 'Ran — notification held',
};

/** No raw enum reaches the UI, including a state this build has never seen. */
export function runStateLabel(state: string): string {
  return RUN_LABEL[state] ?? `Unknown (${state.replaceAll('_', ' ')})`;
}

const RUN_TONE: Record<string, Tone> = {
  pending: 'muted',
  running: 'muted',
  succeeded: 'ok',
  failed: 'danger',
  blocked: 'danger',
  cancelled: 'warning',
  lease_expired: 'danger',
  skipped_overlap: 'warning',
  skipped_catchup: 'warning',
  held: 'warning',
};

/**
 * Slice 2 honesty rule 5, carried forward: a partial or unknown outcome is
 * never green. `held` did run, but its notification did not go out; a skipped
 * or abandoned run is not a success either.
 */
export function runStateTone(state: string): Tone {
  return RUN_TONE[state] ?? 'warning';
}

export type RunLike = {
  state: string;
  classification?: string | null;
  exitCode?: number | null;
  attempt?: number;
  slot?: string;
  summary?: unknown;
};

export type QuietHours = { timezone: string; quietHoursStart: number; quietHoursEnd: number };

export type RunReasonContext = {
  catchupPolicy?: string | null;
  overlapPolicy?: string | null;
  misfireGraceSeconds?: number | null;
  quietHours?: QuietHours | null;
};

/**
 * Requirement 6: "why didn't my job run last night" is answered in the console.
 * The run row carries the state; the policy that produced it lives on the
 * schedule, so the reason is assembled from both.
 */
export function runReason(run: RunLike, ctx: RunReasonContext): string | null {
  switch (run.state) {
    case 'skipped_catchup': {
      const policy = ctx.catchupPolicy ?? 'skip';
      const grace = ctx.misfireGraceSeconds ?? 120;
      return `The scheduler was not running at this slot (more than ${grace}s past due) and `
        + `catch-up policy "${policy}" records it without running it.`;
    }
    case 'skipped_overlap': {
      if (run.classification === 'refused') {
        return 'The schedule was disabled before this run could start — nothing was executed.';
      }
      const policy = ctx.overlapPolicy ?? 'skip';
      return policy === 'queue'
        ? 'Dropped: another run of this schedule was still in flight and its queue was '
          + 'already at the cap.'
        : `Another run of this schedule was still in flight, and overlap policy "${policy}" skips `
          + 'this occurrence rather than running two at once.';
    }
    case 'held': {
      const window = quietHoursBadge(ctx.quietHours ?? null);
      return `The run succeeded, but quiet hours hold its notification (${window}) — the report `
        + 'was still written, and the morning briefing releases it.';
    }
    case 'lease_expired':
      // Honesty rule 6: a half-finished dream costs real money.
      return 'Its worker lease expired mid-run, so the outcome is unknown. It is never retried '
        + 'automatically; the next occurrence runs normally.';
    case 'blocked':
      return 'gbrain refused the command — the alert on this page carries the reason.';
    case 'cancelled':
      return 'Cancelled, either on request or by overlap policy "kill_previous".';
    case 'failed': {
      const exit = run.exitCode ?? null;
      const classification = run.classification ?? 'failed';
      return `The command failed${exit === null ? '' : ` with exit code ${exit}`} `
        + `(${classification}).`;
    }
    default:
      return null;
  }
}

/** Requirement 8: org-local wall clock with the IANA zone named, never a bare offset. */
export function quietHoursBadge(settings: QuietHours | null): string {
  if (!settings?.timezone) return 'quiet hours unknown — no readable org window';
  return `output held ${hhmm(settings.quietHoursStart, 0)}–${hhmm(settings.quietHoursEnd, 0)} `
    + settings.timezone;
}

/** Only a schedule that notifies is badged: output that is never sent is not held. */
export function holdBadge(
  schedule: { notifies?: boolean | null },
  settings: QuietHours | null,
): string | null {
  return schedule.notifies ? quietHoursBadge(settings) : null;
}

/**
 * Requirement 7. A rejected push, a revoked Connection and an expired lease pin
 * above everything else — they are the four that mean work silently stopped.
 *
 * Slice 4's agent kinds are deliberately NOT pinned, and the decision is here
 * so it is not re-litigated: each one has a run row on the Schedules page and a
 * detail view on Runs, so it is never silent. `agent_budget_exceeded` and
 * `agent_run_failed` carry the danger tone below instead, and D12's
 * runner-less deployment (a supported configuration) must not have a banner
 * pinned at the top of every schedule page.
 */
const PINNED_ALERT_KINDS = [
  'push_rejected', 'push_blocked', 'lease_expired', 'connection_revoked',
];

export function isPinnedAlert(kind: string): boolean {
  return PINNED_ALERT_KINDS.includes(kind);
}

const ALERT_LABEL: Record<string, string> = {
  push_rejected: "Push rejected — the remote refused this Space's update",
  push_blocked: 'Push blocked — a scan or a conflict stopped the push',
  lease_expired: 'Lease expired — the run was abandoned and is not retried',
  connection_revoked: 'Connection revoked — its schedules were disabled',
  overlap_queue_full: 'Overlap queue full — queued runs were dropped',
  overlap_killed_previous: 'Overlapping run cancelled (kill_previous)',
  report_write_failed: 'Report write failed — the run has no report',
  // Slice 4, Task 11. The five agent kinds are registered here by hand, and
  // `test/unit/console-schedules.test.ts` fails if one is missing: an
  // unregistered kind falls through to the de-underscored fallback below and
  // reads as an enum instead of a reason.
  agent_budget_exceeded:
    'Agent run stopped — the budget cap for this run was reached',
  agent_run_failed:
    'Agent run failed — the harness exited non-zero or its stream carried error frames',
  agent_read_space_moved:
    'A read Space moved under an agent run — read isolation is broken, so the run is a finding',
  runner_never_seen:
    'Agent runner never claimed — agent schedules cannot run until one connects',
  harness_pin_mismatch:
    'Harness version mismatch — a runner refused the claim rather than run an unknown binary',
};

export function alertLabel(kind: string): string {
  const known = ALERT_LABEL[kind];
  if (known) return known;
  if (kind.startsWith('run_')) return `Run ${kind.slice(4).replaceAll('_', ' ')}`;
  return kind.replaceAll('_', ' ');
}

const ALERT_TONE: Record<string, Tone> = {
  push_rejected: 'danger',
  push_blocked: 'danger',
  lease_expired: 'danger',
  connection_revoked: 'danger',
  report_write_failed: 'danger',
  // Slice 4, Task 11: the two agent kinds that mean work stopped — the money
  // ran out, or the run failed. A `warning` here would be a shrug at a run the
  // operator is paying for. The other three agent kinds are informational and
  // take the default.
  agent_budget_exceeded: 'danger',
  agent_run_failed: 'danger',
  overlap_queue_full: 'warning',
  overlap_killed_previous: 'warning',
  run_cancelled: 'warning',
  run_refused: 'warning',
};

const SEVERE_RUN_ALERTS = ['run_failed', 'run_timeout', 'run_lock_lost', 'run_blocked'];

export function alertTone(kind: string): Tone {
  const known = ALERT_TONE[kind];
  if (known) return known;
  return SEVERE_RUN_ALERTS.includes(kind) ? 'danger' : 'warning';
}

export function openAlerts<A extends { acknowledgedAt: string | null }>(alerts: A[]): A[] {
  return alerts.filter((a) => !a.acknowledgedAt);
}

export function pinnedAlerts<A extends { kind: string; acknowledgedAt: string | null }>(
  alerts: A[],
): A[] {
  return openAlerts(alerts).filter((a) => isPinnedAlert(a.kind));
}

/** An unexplained refusal is still a refusal: 401/403 are not silent. */
export function refusalMessage(body: Record<string, unknown>): string {
  const code = typeof body.error === 'string' ? body.error : '';
  const known = REFUSAL_COPY[code];
  if (known) return known;
  if (/fenced/i.test(code)) return FENCED_COPY;
  // The brain-wide refusal is a sentence, not a code: name the rule it broke.
  if (/brain-wide/i.test(code)) {
    return 'A brain-wide command needs a Connection whose member is admin-or-better.';
  }
  if (code === 'unauthorized' || code === '401') return 'Sign in to manage schedules.';
  const detail = typeof body.detail === 'string' ? body.detail.trim() : '';
  if (code) return detail ? `${code} — ${detail}` : code;
  return 'The control plane refused the request without naming a reason.';
}

const FENCED_COPY =
  "That parameter is computed from the Connection's write Space and cannot be set here.";

const REFUSAL_COPY: Record<string, string> = {
  invalid_name:
    'A schedule name becomes the reports/<name>/ directory: lowercase letters, digits and '
    + 'dashes, starting with a letter or digit.',
  unknown_operation: 'That command is not in the scheduler allowlist.',
  invalid_timezone:
    'Use an IANA zone (UTC or Region/City). A fixed-offset alias like EST is refused — every '
    + 'wall-clock decision a schedule makes assumes real DST.',
  invalid_quiet_hours: 'Quiet hours are whole hours, 0–23.',
  name_taken: 'That name is already used in this org — the name is also the report directory.',
  duplicate_run:
    'A run for this same second already exists. The idempotency key refused the duplicate.',
  schedule_disabled: 'This schedule is disabled, so a manual run would not be a real one.',
  forbidden: 'You can only schedule on your own Connection.',
  not_found: 'That schedule no longer exists.',
  nothing_to_update: 'Nothing changed, so nothing was written.',
  invalid_enabled: 'Enabled must be true or false.',
  invalid_kind: 'A schedule is either an interval or a calendar time.',
  invalid_interval: 'Intervals start at 60 seconds.',
  invalid_calendar: 'That wall clock time is not a valid hour and minute.',
  invalid_calendar_days: 'Days of week run 0 (Sunday) to 6 (Saturday).',
};

/* -------------------------------------------------------------------------
 * The page.
 * ---------------------------------------------------------------------- */

type SpaceOption = { id: string; sourceId: string; name: string };
type MemberOption = { membershipId: string; email: string; role: string };
type RawConnection = {
  id: string; membershipId: string; writeSpaceId: string; clientName: string; state: string;
};
type ConnectionOption = {
  id: string; clientName: string; writeSpace: string | null; memberRole: string | null;
  state: string;
};
type Refusal = { status: number; body: Record<string, unknown> };

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function refusalOf(e: unknown): Refusal {
  if (e instanceof ApiError) return { status: e.status, body: e.body };
  return { status: 0, body: { error: e instanceof Error ? e.message : 'request failed' } };
}

function cadenceLine(s: ScheduleRow): string {
  if (s.kind === 'interval') {
    const seconds = s.intervalSeconds ?? 0;
    return seconds >= 3600 && seconds % 3600 === 0
      ? `every ${seconds / 3600} h`
      : `every ${Math.round(seconds / 60)} min`;
  }
  const days = s.calendarDaysOfWeek;
  const when = Array.isArray(days) && days.length > 0
    ? days.map((d) => DAY_NAMES[d] ?? `day ${d}`).join(', ')
    : 'every day';
  return `${when} at ${hhmm(s.calendarHour ?? 0, s.calendarMinute ?? 0)}`;
}

function intervalChoices(preset: PresetRow | null): number[] {
  const offered = preset?.tunableInterval;
  return Array.isArray(offered) && offered.length > 0 ? offered : [300, 900, 1800, 3600];
}

const DETAIL_KEYS = [
  'message', 'classification', 'exitCode', 'status', 'reason', 'dropped', 'cap', 'cancelled',
  'clientName', 'released',
];

/** S3c: a bounded, redacted summary. History is never a log tail. */
function detailLine(detail: unknown): string | null {
  if (!detail || typeof detail !== 'object') return null;
  const rec = detail as Record<string, unknown>;
  const parts = DETAIL_KEYS
    .filter((k) => rec[k] !== undefined && rec[k] !== null)
    .map((k) => `${k}: ${String(rec[k])}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function summaryLine(run: RunRow): string | null {
  const summary = run.summary;
  if (!summary || typeof summary !== 'object') return null;
  const rec = summary as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof rec.changed === 'number') parts.push(`changed ${rec.changed}`);
  if (typeof rec.status === 'string') parts.push(rec.status);
  if (typeof rec.released === 'number') parts.push(`released ${rec.released}`);
  if (typeof rec.error === 'string') parts.push(rec.error);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function mergeConnections(
  raw: RawConnection[],
  spaces: SpaceOption[],
  members: MemberOption[],
  schedules: ScheduleRow[],
): ConnectionOption[] {
  const spaceLabel = (id: string): string | null => {
    const space = spaces.find((s) => s.id === id);
    return space ? (space.sourceId || space.name) : null;
  };
  const roleOf = (membershipId: string): string | null =>
    members.find((m) => m.membershipId === membershipId)?.role ?? null;

  const byId = new Map<string, ConnectionOption>();
  for (const row of raw) {
    byId.set(row.id, {
      id: row.id,
      clientName: row.clientName,
      writeSpace: spaceLabel(row.writeSpaceId),
      memberRole: roleOf(row.membershipId),
      state: row.state,
    });
  }
  // A member cannot read /api/connections, but their own Connection arrives
  // denormalized on every schedule they can see.
  for (const s of schedules) {
    if (!s.connection || byId.has(s.connection.id)) continue;
    byId.set(s.connection.id, { ...s.connection, state: s.connection.state });
  }
  return [...byId.values()];
}

export function Schedules() {
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [systemPresets, setSystemPresets] = useState<string[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [settings, setSettings] = useState<ScheduleSettings | null>(null);
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAcked, setShowAcked] = useState(false);

  const [runs, setRuns] = useState<RunRow[]>([]);
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState('live-sync');
  const [connectionId, setConnectionId] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(900);
  const [calendarHour, setCalendarHour] = useState(2);
  const [calendarMinute, setCalendarMinute] = useState(5);
  const [days, setDays] = useState('');
  const [notifies, setNotifies] = useState(false);
  const [createRefusal, setCreateRefusal] = useState<Refusal | null>(null);
  /**
   * D3: the operator's own agent payload, tagged with the preset it was edited
   * from — so switching presets re-opens on the new preset's values (the payload
   * IS the preset until it is touched) and the four fields are never stale.
   */
  const [agentDraft, setAgentDraft] = useState<{ presetId: string; draft: AgentDraft } | null>(null);

  const [tzDraft, setTzDraft] = useState('');
  const [quietStart, setQuietStart] = useState(23);
  const [quietEnd, setQuietEnd] = useState(8);
  const [editingWindow, setEditingWindow] = useState(false);

  const load = useCallback(async () => {
    const [list, presetBody, alertBody, settingsBody, overview, raw] = await Promise.all([
      scheduleApi.list(),
      scheduleApi.presets().catch(() => ({ presets: [] as PresetRow[], system: [] as string[] })),
      scheduleApi.alerts().catch(() => ({ alerts: [] as AlertRow[] })),
      scheduleApi.settings().catch(() => ({ settings: null })),
      api.get<{ members: MemberOption[]; spaces: SpaceOption[] }>('/access-overview')
        .catch(() => ({ members: [] as MemberOption[], spaces: [] as SpaceOption[] })),
      api.get<{ connections: RawConnection[] }>('/connections')
        .catch(() => ({ connections: [] as RawConnection[] })),
    ]);

    setSchedules(list.schedules);
    setPresets(presetBody.presets);
    setSystemPresets(presetBody.system);
    setAlerts(alertBody.alerts);
    if (settingsBody.settings) {
      setSettings(settingsBody.settings);
      setTzDraft((current) => current || settingsBody.settings!.timezone);
      setQuietStart(settingsBody.settings.quietHoursStart);
      setQuietEnd(settingsBody.settings.quietHoursEnd);
    }
    setConnections(mergeConnections(raw.connections, overview.spaces, overview.members, list.schedules));
    setError(null);
  }, []);

  useEffect(() => {
    void load().catch((e) => setError(refusalMessage(refusalOf(e).body)));
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => { void load().catch(() => { /* the next poll retries */ }); }, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  // A run in flight is the one thing an operator watches. The list poll above is
  // slow on purpose; an OPEN history refreshes on its own cadence so a run does
  // not sit at "Queued" while the scheduler has already finished it.
  useEffect(() => {
    if (!runsFor) return;
    const timer = setInterval(() => {
      void scheduleApi.runs(runsFor)
        .then((history) => setRuns(history.runs))
        .catch(() => { /* the next tick retries */ });
    }, 10_000);
    return () => clearInterval(timer);
  }, [runsFor]);

  const step = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); }
    catch (e) { setError(refusalMessage(refusalOf(e).body)); }
    finally { setBusy(false); }
  };

  const preset = useMemo(
    () => presets.find((p) => p.id === presetId) ?? null,
    [presets, presetId],
  );
  // D12/honesty rule 3: an agent schedule spends money, so the run the operator
  // is buying is on screen before the Create button, not discovered on a bill.
  const agentPayload = useMemo(() => agentPayloadOf(preset), [preset]);
  const chosen = connections.find((c) => c.id === connectionId) ?? null;
  const scope = preset
    ? presetScope(preset)
    : 'source';
  const blocked = confirmBlockedFor({ scope, memberRole: chosen?.memberRole ?? null });
  const blockedReason = blocked && scope === 'brain-wide' && chosen
    ? `This command reads the whole brain, and ${chosen.clientName}'s member is `
      + `"${chosen.memberRole ?? 'unknown'}" — admin or owner is required.`
    : null;

  // D3: the preset's payload is the DEFAULT; an edited draft wins until the
  // preset changes. Fall back to the preset even if `presets` has not loaded
  // yet, so the fields are never blank for an agent preset.
  const draft: AgentDraft | null = agentPayload === null || preset === null
    ? null
    : agentDraft?.presetId === preset.id
      ? agentDraft.draft
      : agentDraftOf(agentPayload);
  const refusals = draft === null ? [] : agentFormRefusals(draft);
  const editAgent = (patch: Partial<AgentDraft>) => {
    if (draft === null || preset === null) return;
    setAgentDraft({ presetId: preset.id, draft: { ...draft, ...patch } });
    setCreateRefusal(null);
  };

  const pickPreset = (id: string) => {
    setPresetId(id);
    setCreateRefusal(null);
    const next = presets.find((p) => p.id === id);
    if (!next) return;
    // A different preset is a different payload: drop the edits with it.
    setAgentDraft(null);
    const defaults = next.defaults;
    if (typeof defaults.intervalSeconds === 'number') setIntervalSeconds(defaults.intervalSeconds);
    if (typeof defaults.calendarHour === 'number') setCalendarHour(defaults.calendarHour);
    if (typeof defaults.calendarMinute === 'number') setCalendarMinute(defaults.calendarMinute);
    const presetDays = defaults.calendarDaysOfWeek;
    setDays(Array.isArray(presetDays) ? presetDays.join(',') : '');
  };

  const parsedDays = (): number[] | null => {
    const parts = days.split(',').map((d) => d.trim()).filter(Boolean).map(Number);
    if (parts.length === 0) return null;
    if (parts.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new Error('Days of week run 0 (Sunday) to 6 (Saturday).');
    }
    return parts;
  };

  const submit = (override?: { calendarMinute?: number }) => step(async () => {
    setCreateRefusal(null);
    setNotice(null);
    const body: CreateScheduleBody = { name, connectionId, preset: presetId };
    if (notifies) body.notifies = true;
    // D3: what the form shows IS the payload the run will carry. The four keys
    // are sent even when untouched — a one-click create on an agent preset
    // sends the preset's own values, and the route accepts them all the same.
    if (draft !== null) Object.assign(body, agentCreateFields(draft));
    if (preset?.kind === 'interval') {
      body.intervalSeconds = intervalSeconds;
    } else if (preset?.kind === 'calendar') {
      body.calendarHour = calendarHour;
      body.calendarMinute = override?.calendarMinute ?? calendarMinute;
      const daysOfWeek = parsedDays();
      if (daysOfWeek) body.calendarDaysOfWeek = daysOfWeek;
    }
    try {
      const created = await scheduleApi.create(body);
      setNotice(`Created ${created.name} — ${connectionLine(created.connection)}`);
      setName('');
      await load();
    } catch (e) {
      const refusal = refusalOf(e);
      // Requirement 4: attach the requested wall time, which the 409 body omits.
      setCreateRefusal(
        refusal.body.error === 'slot_taken'
          ? { ...refusal, body: { ...refusal.body, requested: { hour: calendarHour, minute: override?.calendarMinute ?? calendarMinute } } }
          : refusal,
      );
    }
  });

  const acknowledge = (id: string) => step(async () => {
    await scheduleApi.acknowledge(id);
    await load();
  });

  const runNow = (schedule: ScheduleRow) => step(async () => {
    const result = await scheduleApi.runNow(schedule.id);
    setNotice(`Queued a manual run of ${schedule.name} (slot ${result.run.slot}).`);
    await load();
    await loadRuns(schedule.id);
  });

  const toggleEnabled = (schedule: ScheduleRow) => step(async () => {
    await scheduleApi.update(schedule.id, { enabled: !schedule.enabled });
    await load();
  });

  const removeSchedule = (schedule: ScheduleRow) => step(async () => {
    await scheduleApi.remove(schedule.id);
    setConfirmDelete(null);
    if (runsFor === schedule.id) setRunsFor(null);
    setNotice(`Deleted ${schedule.name}. Its run history went with it.`);
    await load();
  });

  const loadRuns = async (scheduleId: string) => {
    const history = await scheduleApi.runs(scheduleId);
    setRuns(history.runs);
    setRunsFor(scheduleId);
  };

  const toggleRuns = (schedule: ScheduleRow) => step(async () => {
    if (runsFor === schedule.id) { setRunsFor(null); return; }
    await loadRuns(schedule.id);
  });

  const disableHolder = (holderId: string) => step(async () => {
    await scheduleApi.update(holderId, { enabled: false });
    await load();
    await submit();
  });

  const saveWindow = () => step(async () => {
    const saved = await scheduleApi.saveSettings({
      timezone: tzDraft,
      quietHoursStart: quietStart,
      quietHoursEnd: quietEnd,
    });
    setSettings(saved.settings);
    setEditingWindow(false);
    setNotice(`Quiet hours now ${quietHoursBadge(saved.settings)}.`);
    await load();
  });

  const open = openAlerts(alerts);
  const pinned = pinnedAlerts(alerts);
  const acknowledged = alerts.filter((a) => a.acknowledgedAt);
  const pinnedIds = useMemo(() => pinned.map((a) => a.id), [pinned]);
  const holder = createRefusal?.body.error === 'slot_taken'
    ? slotHolder(schedules, {
      hour: calendarHour,
      minute: calendarMinute,
      daysOfWeek: (() => { try { return parsedDays(); } catch { return null; } })(),
    })
    : null;
  const laneHolder = createRefusal?.body.error === 'sub_hourly_limit'
    && typeof createRefusal.body.holder === 'string'
    ? laneHolderId(schedules, createRefusal.body.holder)
    : null;

  return (
    <div className="max-w-3xl space-y-8">
      <header>
        <h1 className="text-xl font-semibold">Schedules</h1>
        <p className="text-sm text-muted">
          Every schedule runs as a Connection, never as a Member. The Connection decides the
          Space that is synced, where the report lands, and whose name is on the commit.
        </p>
      </header>

      {error && <div className="text-danger text-sm">{error}</div>}
      {notice && <div className="text-sm text-muted">{notice}</div>}

      {/* Requirement 7: the alerts the operator must not miss, before anything else. */}
      {pinned.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium text-warning">Alerts that stopped work</h2>
          {pinned.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              scheduleName={schedules.find((s) => s.id === alert.scheduleId)?.name ?? null}
              busy={busy}
              onAcknowledge={() => void acknowledge(alert.id)}
            />
          ))}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-medium">Schedules</h2>
        {schedules.length === 0 && <p className="text-sm text-muted">No schedules yet.</p>}
        {schedules.map((schedule) => (
          <div key={schedule.id} className="card space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">
                  {schedule.name}
                  {schedule.preset && (
                    <span className="ml-2 text-xs text-muted font-mono">{schedule.preset}</span>
                  )}
                </div>
                {/* Requirement 1. */}
                <div className="text-sm text-muted">{connectionLine(schedule.connection)}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-sm">{schedule.operation}</div>
                <div className="text-xs text-muted">{cadenceLine(schedule)}</div>
              </div>
            </div>

            {commandScope(schedule.operation) === 'brain-wide' && (
              <div className="card border-warning text-sm">
                {bannerFor({
                  scope: 'brain-wide',
                  writeSpace: schedule.connection?.writeSpace ?? null,
                })}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={schedule.enabled ? 'text-ok' : 'text-warning'}>
                {schedule.enabled ? 'enabled' : 'disabled'}
              </span>
              {schedule.disabledReason && (
                <span className="text-warning font-mono">{schedule.disabledReason}</span>
              )}
              {/* Requirement 8. */}
              {holdBadge(schedule, settings) && (
                <span className="text-muted font-mono">{holdBadge(schedule, settings)}</span>
              )}
              <span className="text-muted">
                overlap {schedule.overlapPolicy} · catch-up {schedule.catchupPolicy} · report{' '}
                {schedule.reportPolicy}
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              <button className="nav-item" disabled={busy || !schedule.enabled}
                      onClick={() => void runNow(schedule)}>
                Run now
              </button>
              <button className="nav-item" disabled={busy}
                      onClick={() => void toggleEnabled(schedule)}>
                {schedule.enabled ? 'Pause' : 'Enable'}
              </button>
              <button className="nav-item" disabled={busy}
                      onClick={() => void toggleRuns(schedule)}>
                {runsFor === schedule.id ? 'Hide runs' : 'Run history'}
              </button>
              {confirmDelete === schedule.id ? (
                <>
                  <button className="nav-item text-danger" disabled={busy}
                          onClick={() => void removeSchedule(schedule)}>
                    Confirm delete
                  </button>
                  <button className="nav-item" onClick={() => setConfirmDelete(null)}>
                    Keep it
                  </button>
                </>
              ) : (
                <button className="nav-item text-danger" disabled={busy}
                        onClick={() => setConfirmDelete(schedule.id)}>
                  Delete
                </button>
              )}
            </div>

            {runsFor === schedule.id && (
              <RunHistory runs={runs} schedule={schedule} settings={settings} />
            )}
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">New schedule</h2>

        <label className="text-sm">What it does
          <select className="field mt-1" value={presetId} onChange={(e) => pickPreset(e.target.value)}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>{p.title} ({p.id})</option>
            ))}
          </select>
        </label>
        {preset && <p className="text-sm text-muted">{preset.description}</p>}
        {preset && preset.defaults && (
          <p className="text-xs text-muted font-mono">
            {preset.kind} · operation {preset.operation ?? (agentPayload ? 'agent_prompt' : 'none (internal drain)')}
            {preset.params && Object.keys(preset.params).length > 0
              ? ` · params ${JSON.stringify(preset.params)}`
              : ''}
          </p>
        )}

        {/* D3: the agent payload is editable, pre-filled from the preset. The
            harness pin stays derived at creation, and an unpriced model is
            refused here in the server's own words rather than by a run at 3am. */}
        {draft !== null && agentPayload !== null && (
          <div className="card space-y-3">
            <p className="text-sm font-medium">What this run will do</p>
            <label className="text-sm block">Prompt
              <textarea className="field mt-1 font-mono h-40" value={draft.prompt}
                        onChange={(e) => editAgent({ prompt: e.target.value })} />
            </label>
            <div className="grid grid-cols-3 gap-3">
              <label className="text-sm">Model (priced on {PRICED_AT})
                <select className="field mt-1 font-mono" value={draft.model}
                        onChange={(e) => editAgent({ model: e.target.value })}>
                  {/* The preset's own model first: a one-click create sends it. */}
                  {(PRICED_MODELS.includes(draft.model) ? PRICED_MODELS : [draft.model, ...PRICED_MODELS])
                    .map((model) => (
                      <option key={model} value={model}>
                        {rateFor(model) === null ? `${model} — not priced` : model}
                      </option>
                    ))}
                </select>
              </label>
              <label className="text-sm">Output cap (tokens)
                <input className="field mt-1 font-mono" type="number"
                       value={draft.maxTokens}
                       onChange={(e) => editAgent({ maxTokens: e.target.value })} />
              </label>
              <label className="text-sm">Budget per run (USD)
                <input className="field mt-1 font-mono" value={draft.budgetUsd}
                       onChange={(e) => editAgent({ budgetUsd: e.target.value })} />
              </label>
            </div>
            <p className="text-xs text-muted">
              These four are the run's payload: the runner hands the prompt to the pinned Claude
              Code harness under this model, cap and budget, and the harness version is this
              deployment's pin — a runner whose own pin differs refuses the run instead of running
              an unknown binary. The preset's own values are the defaults; the model picker is the
              shipped price table ({PRICED_MODELS.length} models, pinned {PRICED_AT}), and a model
              absent from it is refused here in the same words the server uses.
            </p>
            {refusals.length > 0 && (
              <div className="card border-warning space-y-1">
                <p className="text-sm text-warning">
                  This payload would be refused at creation, so Create is off:
                </p>
                {refusals.map((r) => (
                  <p key={r.field} className="text-xs text-muted font-mono">
                    {r.field}: {r.detail}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        <label className="text-sm">Name (becomes reports/&lt;name&gt;/)
          <input className="field mt-1 font-mono" value={name} placeholder="live-sync"
                 onChange={(e) => { setName(e.target.value); setCreateRefusal(null); }} />
        </label>

        <label className="text-sm">Connection
          <select className="field mt-1" value={connectionId}
                  onChange={(e) => { setConnectionId(e.target.value); setCreateRefusal(null); }}>
            <option value="">Select a Connection…</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.clientName} · {c.writeSpace ?? 'no Space'} · {c.memberRole ?? 'unknown role'} ({c.state})
              </option>
            ))}
          </select>
        </label>
        {chosen ? (
          <p className="text-sm text-muted font-mono">
            {connectionLine(chosen)} — {memberRoleLine(chosen.memberRole)}
          </p>
        ) : (
          <p className="text-sm text-muted">
            {connections.length === 0
              ? 'No Connection you can schedule on. Create one on the Connection page first.'
              : 'Pick a Connection: it is what the schedule runs as.'}
          </p>
        )}

        {preset?.kind === 'interval' && (
          <label className="text-sm">Interval
            <select className="field mt-1" value={intervalSeconds}
                    onChange={(e) => { setIntervalSeconds(Number(e.target.value)); setCreateRefusal(null); }}>
              {intervalChoices(preset).map((secs) => (
                <option key={secs} value={secs}>{secs / 60} minutes</option>
              ))}
            </select>
          </label>
        )}

        {preset?.kind === 'calendar' && (
          <div className="grid grid-cols-3 gap-3">
            <label className="text-sm">Hour
              <input className="field mt-1 font-mono" type="number" min={0} max={23}
                     value={calendarHour}
                     onChange={(e) => { setCalendarHour(Number(e.target.value)); setCreateRefusal(null); }} />
            </label>
            <label className="text-sm">Minute (snaps to the :05…:50 grid)
              <input className="field mt-1 font-mono" type="number" min={0} max={59}
                     value={calendarMinute}
                     onChange={(e) => { setCalendarMinute(Number(e.target.value)); setCreateRefusal(null); }} />
            </label>
            <label className="text-sm">Days (0=Sun, empty = daily)
              <input className="field mt-1 font-mono" value={days} placeholder="1,3"
                     onChange={(e) => { setDays(e.target.value); setCreateRefusal(null); }} />
            </label>
          </div>
        )}

        {/* Requirement 8: a notifying job is badged, so this has to be reachable. */}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={notifies}
                 onChange={(e) => setNotifies(e.target.checked)} />
          Hold its output during quiet hours (the report is still written; the morning briefing
          releases it)
        </label>

        {createRefusal && (
          <RefusalCard
            refusal={createRefusal}
            holder={holder}
            holderId={laneHolder}
            hour={calendarHour}
            busy={busy}
            onUseNextSlot={(minute) => { setCalendarMinute(minute); void submit({ calendarMinute: minute }); }}
            onDisableHolder={(id) => void disableHolder(id)}
            onDismiss={() => setCreateRefusal(null)}
          />
        )}

        {/* Requirements 2 and 3: the disclosure, above the confirm button. */}
        <div className={scope === 'brain-wide' ? 'card border-warning' : 'card'}>
          <p className="text-sm">{bannerFor({ scope, writeSpace: chosen?.writeSpace ?? null })}</p>
          {scope === 'brain-wide' && blocked && blockedReason && (
            <p className="text-sm text-warning mt-2">{blockedReason}</p>
          )}
        </div>

        <button className="btn-primary"
                disabled={busy || !name || !connectionId || blocked || connections.length === 0
                  || refusals.length > 0}
                onClick={() => void submit()}>
          {busy ? 'Creating…' : 'Create schedule'}
        </button>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Alerts</h2>
        {open.length === 0 && <p className="text-sm text-muted">No open alerts.</p>}
        {open.filter((a) => !pinnedIds.includes(a.id)).map((alert) => (
          <AlertCard
            key={alert.id}
            alert={alert}
            scheduleName={schedules.find((s) => s.id === alert.scheduleId)?.name ?? null}
            busy={busy}
            onAcknowledge={() => void acknowledge(alert.id)}
          />
        ))}
        {acknowledged.length > 0 && (
          <button className="nav-item" onClick={() => setShowAcked((v) => !v)}>
            {showAcked ? 'Hide' : 'Show'} {acknowledged.length} acknowledged alert
            {acknowledged.length === 1 ? '' : 's'}
          </button>
        )}
        {showAcked && acknowledged.map((alert) => (
          <div key={alert.id} className="text-xs text-muted font-mono">
            {alertLabel(alert.kind)} · acked {new Date(alert.acknowledgedAt!).toLocaleString()}
          </div>
        ))}
        {systemPresets.length > 0 && (
          <p className="text-xs text-muted">
            System schedules this org qualifies for, installed by the scheduler:{' '}
            {systemPresets.join(', ')}
          </p>
        )}
      </section>

      {/* Requirement 8: the window, in org-local time, with its IANA zone named. */}
      <section className="space-y-2">
        <h2 className="font-medium">Quiet hours</h2>
        <p className="text-sm font-mono">{quietHoursBadge(settings)}</p>
        <p className="text-sm text-muted">
          A notifying schedule still runs during this window: the report is written and the
          notification is held until the morning briefing releases it. Nothing is dropped.
        </p>
        {editingWindow ? (
          <div className="space-y-2">
            <label className="text-sm">IANA timezone
              <input className="field mt-1 font-mono" value={tzDraft} placeholder="America/New_York"
                     onChange={(e) => setTzDraft(e.target.value)} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">Held from (hour)
                <input className="field mt-1 font-mono" type="number" min={0} max={23}
                       value={quietStart} onChange={(e) => setQuietStart(Number(e.target.value))} />
              </label>
              <label className="text-sm">Held until (hour)
                <input className="field mt-1 font-mono" type="number" min={0} max={23}
                       value={quietEnd} onChange={(e) => setQuietEnd(Number(e.target.value))} />
              </label>
            </div>
            <div className="flex gap-2">
              <button className="btn-primary" disabled={busy || !tzDraft}
                      onClick={() => void saveWindow()}>
                {busy ? 'Saving…' : 'Save window'}
              </button>
              <button className="nav-item" onClick={() => setEditingWindow(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="nav-item" onClick={() => setEditingWindow(true)}>
            Change timezone or quiet hours
          </button>
        )}
      </section>
    </div>
  );
}

function RunHistory({
  runs, schedule, settings,
}: {
  runs: RunRow[];
  schedule: ScheduleRow;
  settings: ScheduleSettings | null;
}) {
  const context = {
    catchupPolicy: schedule.catchupPolicy,
    overlapPolicy: schedule.overlapPolicy,
    misfireGraceSeconds: schedule.misfireGraceSeconds,
    quietHours: settings,
  };

  return (
    <div className="space-y-2">
      <div className="text-sm text-muted">
        Last {runs.length} occurrence{runs.length === 1 ? '' : 's'} — the run row is the record,
        never a log tail.
      </div>
      {runs.length === 0 && <p className="text-sm text-muted">Nothing has fired yet.</p>}
      {runs.map((run) => {
        const reason = runReason(run, context);
        const summary = summaryLine(run);
        const clocks = slotClocks(run.slot, run.fireAt);
        return (
          <div key={run.id} className="border-b border-subtle pb-2 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className={TONE_CLASS[runStateTone(run.state)]}>{runStateLabel(run.state)}</span>
              <span className="font-mono text-xs text-muted">
                {clocks.org} · {clocks.viewer}
                {run.exitCode === null || run.exitCode === undefined
                  ? ''
                  : ` · exit ${run.exitCode}`}
              </span>
            </div>
            {reason && <p className="text-xs text-muted">{reason}</p>}
            {summary && <p className="text-xs text-muted font-mono">{summary}</p>}
            {run.reportPath && (
              <p className="text-xs font-mono text-muted">report {run.reportPath}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AlertCard({
  alert, scheduleName, busy, onAcknowledge,
}: {
  alert: AlertRow;
  scheduleName: string | null;
  busy: boolean;
  onAcknowledge: () => void;
}) {
  return (
    <div className="card space-y-1">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className={TONE_CLASS[alertTone(alert.kind)]}>{alertLabel(alert.kind)}</div>
          <div className="text-xs text-muted font-mono">
            {scheduleName ?? alert.scheduleId ?? 'org-wide'} · {new Date(alert.at).toLocaleString()}
          </div>
          {detailLine(alert.detail) && (
            <div className="text-xs text-muted">{detailLine(alert.detail)}</div>
          )}
        </div>
        <button className="nav-item shrink-0" disabled={busy} onClick={onAcknowledge}>
          Acknowledge
        </button>
      </div>
    </div>
  );
}

/**
 * Requirements 4 and 5: a `slot_taken` or `sub_hourly_limit` refusal is a
 * choice with a one-click fix, never a raw error string.
 */
function RefusalCard({
  refusal, holder, holderId, hour, busy, onUseNextSlot, onDisableHolder, onDismiss,
}: {
  refusal: Refusal;
  holder: string | null;
  holderId: string | null;
  hour: number;
  busy: boolean;
  onUseNextSlot: (minute: number) => void;
  onDisableHolder: (id: string) => void;
  onDismiss: () => void;
}) {
  const { body } = refusal;

  if (body.error === 'slot_taken') {
    const requested = (body.requested ?? { hour, minute: 0 }) as { hour: number; minute: number };
    const nextFree = typeof body.nextFree === 'number' ? body.nextFree : null;
    const message = holder
      ? conflictMessage({ nextFree, requested }, holder)
      : `That slot is taken. Next free: ${nextFree === null ? 'none this hour' : hhmm(requested.hour, nextFree)}`;
    return (
      <div className="card border-warning space-y-2">
        <p className="text-sm text-warning">{message}</p>
        <div className="flex flex-wrap gap-2">
          <button className="nav-item" disabled={busy || nextFree === null}
                  onClick={() => onUseNextSlot(nextFree ?? requested.minute)}>
            {nextFree === null ? 'No free slot this hour' : `Use ${hhmm(requested.hour, nextFree)}`}
          </button>
          <button className="nav-item" onClick={onDismiss}>Choose another time</button>
        </div>
      </div>
    );
  }

  if (body.error === 'sub_hourly_limit') {
    const holderName = typeof body.holder === 'string' ? body.holder : null;
    const detail = typeof body.detail === 'string' ? body.detail : null;
    return (
      <div className="card border-warning space-y-2">
        <p className="text-sm text-warning">{subHourlyMessage({ holder: holderName, detail })}</p>
        <div className="flex flex-wrap gap-2">
          {holderId && (
            <button className="nav-item" disabled={busy}
                    onClick={() => onDisableHolder(holderId)}>
              Disable {holderName} and create this one
            </button>
          )}
          <button className="nav-item" onClick={onDismiss}>Keep it as it is</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card border-warning space-y-2">
      <p className="text-sm text-warning">{refusalMessage(body)}</p>
      <button className="nav-item" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
