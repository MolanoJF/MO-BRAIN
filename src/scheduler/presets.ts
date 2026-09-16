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

export type Preset = {
  id: string;
  title: string;
  description: string;
  kind: 'interval' | 'calendar';
  /** null only for morning-briefing, which runs no gbrain command. */
  operation: string | null;
  params: Record<string, unknown>;
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
