import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '../control/db/client.ts';

/**
 * docs/guides/cron-schedule.md:329 — "Don't over-cron. 20+ jobs sounds like a
 * lot. Start with: email (30 min), dream cycle (nightly), brain health
 * (weekly)." There is no email collector here, so the high-frequency lane is
 * sync + embed --stale, which is what live-sync.md schedules.
 *
 * The two `system: true` entries install only when their precondition holds.
 */
export type PresetDefaults = {
  intervalSeconds?: number;
  calendarHour?: number;
  calendarMinute?: number;
  calendarDaysOfWeek?: number[] | null;
  slotMinute?: number;
  catchupPolicy?: 'skip' | 'run_latest' | 'run_all';
  overlapPolicy?: 'skip' | 'queue' | 'kill_previous';
  reportPolicy?: 'always' | 'on_change_or_failure' | 'never';
  timeoutSeconds?: number;
  notifies?: boolean;
};

/**
 * The agent payload a preset carries. The harness pin is NOT here: it is derived
 * from `HARNESS_PIN` at creation, exactly as `--source` is fenced for a command,
 * so a preset cannot pin a build the deployment is not running.
 */
export type PresetAgent = {
  /** Thin on purpose: a pointer at what to do, not an inlined essay. */
  prompt: string;
  /** A key of MODEL_PRICING. An unpriced model is refused at creation (honesty rule 3). */
  model: string;
  maxTokens: number;
  /** Text, like the column: money never becomes a float. */
  budgetUsd: string;
};

export type Preset = {
  id: string;
  title: string;
  description: string;
  kind: 'interval' | 'calendar';
  /**
   * The payload shape this preset stores (D2). Defaults to `gbrain_command`:
   * `agent` and `jobType: 'agent_prompt'` go together, because
   * `shape_matches_job_type` allows exactly one shape per row.
   */
  jobType?: 'agent_prompt';
  /** null only for the internal drains, which run no gbrain command. */
  operation: string | null;
  params: Record<string, unknown>;
  /** Set iff `jobType === 'agent_prompt'`. */
  agent?: PresetAgent;
  defaults: PresetDefaults;
  tunableInterval?: number[];
  requiresRole?: 'admin';
  system?: true;
};

export const PRESETS: Record<string, Preset> = {
  'live-sync': {
    id: 'live-sync',
    title: 'Keep the brain current',
    description:
      'Imports new commits from this Space and embeds anything stale. '
      + 'Reports are written only when something changed or the run failed.',
    kind: 'interval',
    operation: 'sync',
    params: {},
    defaults: {
      intervalSeconds: 900,
      catchupPolicy: 'skip',
      overlapPolicy: 'skip',
      reportPolicy: 'on_change_or_failure',
      timeoutSeconds: 900,
    },
    tunableInterval: [300, 600, 900, 1200, 1800],
  },

  'nightly-dream': {
    id: 'nightly-dream',
    title: 'Nightly maintenance cycle',
    description:
      'gbrain dream: lint, backlinks, extract, sync, embed, synthesize. '
      + 'This run makes model calls and costs money.',
    kind: 'calendar',
    operation: 'dream',
    params: { maxUsd: 10, yes: true },
    defaults: {
      calendarHour: 2, calendarMinute: 5, calendarDaysOfWeek: null, slotMinute: 5,
      catchupPolicy: 'skip', overlapPolicy: 'skip', reportPolicy: 'always',
      timeoutSeconds: 7200,
    },
  },

  'weekly-health': {
    id: 'weekly-health',
    title: 'Weekly brain health check',
    description:
      'gbrain doctor --remediate with a $5 ceiling. This job reads the WHOLE '
      + 'brain, not just one Space, so it needs an admin Connection.',
    kind: 'calendar',
    operation: 'doctor',
    params: { remediate: true, yes: true, maxUsd: 5 },
    defaults: {
      calendarHour: 6, calendarMinute: 10, calendarDaysOfWeek: [1], slotMinute: 10,
      catchupPolicy: 'skip', overlapPolicy: 'skip', reportPolicy: 'always',
      timeoutSeconds: 3600,
    },
    requiresRole: 'admin',
  },

  /**
   * docs/guides/cron-schedule.md recommends `autopilot --status` daily at 7 AM
   * as a health gate. In Mobrain it is a TRIPWIRE instead: autopilot is never
   * installed here, so a healthy run is always "not installed" and writes no
   * report, and any install at all raises a pinned autopilot_installed alert
   * (docs/autopilot-status-findings.md). Filesystem-only, so the timeout is
   * the DB floor's neighbourhood, not doctor's hour.
   */
  'autopilot-tripwire': {
    id: 'autopilot-tripwire',
    title: 'Competing-scheduler tripwire',
    description:
      "Checks daily that gbrain's own autopilot scheduler was never installed on this brain. "
      + 'Mobrain schedules everything itself, so an install means two schedulers are running '
      + 'the same jobs — that raises an alert. Silent when all is well. Needs an admin Connection.',
    kind: 'calendar',
    operation: 'autopilot-status',
    params: {},
    defaults: {
      calendarHour: 7, calendarMinute: 5, calendarDaysOfWeek: null, slotMinute: 5,
      catchupPolicy: 'skip', overlapPolicy: 'skip', reportPolicy: 'on_change_or_failure',
      timeoutSeconds: 60,
    },
    requiresRole: 'admin',
  },

  /**
   * The push reconcile deferred from Slice 1. Roadmap: "push as a scheduled
   * reconcile job, not inline — with a rejected non-fast-forward surfaced as an
   * alert, never silently swallowed."
   */
  'push-reconcile': {
    id: 'push-reconcile',
    title: 'Push this Space to its git remote',
    description:
      'Scan-gated add, commit, pull, push. A rejected non-fast-forward raises '
      + 'an alert; it is never silently swallowed.',
    kind: 'calendar',
    operation: 'sources-push',
    params: {},
    defaults: {
      calendarHour: 4, calendarMinute: 15, calendarDaysOfWeek: null, slotMinute: 15,
      catchupPolicy: 'skip', overlapPolicy: 'skip', reportPolicy: 'always',
      timeoutSeconds: 1800,
    },
    system: true,
  },

  /**
   * The drain half of quiet hours. Makes no gbrain call and no model call:
   * it releases held notifications into one report. "Held messages MUST be
   * picked up" (docs/guides/cron-schedule.md).
   */
  'morning-briefing': {
    id: 'morning-briefing',
    title: 'Morning briefing',
    description: 'Releases everything held overnight into one report.',
    kind: 'calendar',
    operation: null,
    params: {},
    defaults: {
      calendarHour: 8, calendarMinute: 5, calendarDaysOfWeek: null, slotMinute: 5,
      catchupPolicy: 'run_latest', overlapPolicy: 'skip', reportPolicy: 'always',
      timeoutSeconds: 300,
    },
    system: true,
  },

  /**
   * The one agent preset. "Don't over-cron" is the guide's own advice
   * (docs/guides/cron-schedule.md:329), and this is the lane where over-cronning
   * is expensive: every fire spends the organization's API budget unattended.
   * One nightly job, on the cheapest priced model, with a hard cap.
   *
   * It runs no gbrain command, so `operation` is null — `shape_matches_job_type`
   * forbids an operation on an agent row — and its harness version is derived at
   * creation, never carried here.
   */
  'nightly-agent-briefing': {
    id: 'nightly-agent-briefing',
    title: 'Nightly agent briefing',
    description:
      'An agent run: the runner hands this prompt to the pinned harness against your '
      + "brain, using your organization's API key, with nobody watching. It can only call "
      + 'the gbrain tools your Connection is allowed — never a shell — and every run costs '
      + 'real money, capped per run.',
    kind: 'calendar',
    jobType: 'agent_prompt',
    operation: null,
    params: {},
    agent: {
      prompt:
        "Read the pages under this Connection's write Space that changed in the last 24 "
        + 'hours and write one briefing page at reports/nightly-briefing/: what changed, '
        + 'what looks wrong, and what needs a human. One page. Do not edit anything else.',
      model: 'claude-haiku-4-5',
      maxTokens: 16384,
      budgetUsd: '2',
    },
    defaults: {
      calendarHour: 3, calendarMinute: 5, calendarDaysOfWeek: null, slotMinute: 5,
      catchupPolicy: 'skip', overlapPolicy: 'skip', reportPolicy: 'always',
      timeoutSeconds: 1800,
    },
  },
};

/** Which system schedules this org currently qualifies for. */
export async function systemPresetsFor(orgId: string): Promise<string[]> {
  const db = getDb();
  const out: string[] = [];

  const [remote] = await db.select({ id: schema.spaces.id }).from(schema.spaces)
    .where(and(eq(schema.spaces.organizationId, orgId), isNotNull(schema.spaces.gitRemote)))
    .limit(1);
  if (remote) out.push('push-reconcile');

  const [notifier] = await db.select({ id: schema.schedules.id }).from(schema.schedules)
    .where(and(eq(schema.schedules.organizationId, orgId), eq(schema.schedules.notifies, true)))
    .limit(1);
  if (notifier) out.push('morning-briefing');

  return out;
}
