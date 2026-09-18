/**
 * Spend rollups (D9).
 *
 * gbrain's own `budget_usd_per_day` is per OAuth client, and a member has
 * several clients after Slice 2, so it does not aggregate on its own. This
 * module rolls OUR metered spend up per member, per schedule and per model,
 * and names what it cannot attribute.
 *
 * Three honesty rules live in code here:
 *
 *   1. A cost we could not price is `null`, never `0`. A group whose runs are
 *      all unpriced reports `costUsd: null`; a run we could not price is
 *      counted in `unpricedRuns` rather than dropped.
 *   2. A run whose Connection is gone (`connection_id` is `on delete set null`,
 *      deliberately, so the audit survives) rolls up under `unattributed`, on
 *      its own row, and is never folded into a member's total.
 *   3. Ours is not the whole bill. The totals read here cover only model calls
 *      that traversed our own gateway; gbrain's ledger is a separate figure
 *      (`brainUsage`) that is never added to ours.
 *
 * The queries are pure reads over `agent_runs` / `agent_run_usage` /
 * `connections` / `memberships` / `users` / `schedule_runs` / `schedules`.
 * `rollup` is pure and takes already-joined rows, so the arithmetic is testable
 * without a database.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import { brainUsage } from './opsClient.ts';
import type { BrainUsage } from '../ops/usage.ts';

export type SpendRow = { key: string; label: string; runs: number; costUsd: number | null; unpricedRuns: number };
export type SpendReport = {
  windowDays: number;
  ours: { totalUsd: number | null; unpricedRuns: number;
          byMember: SpendRow[]; bySchedule: SpendRow[]; byModel: SpendRow[] };
  brain: BrainUsage | null;
  coverage: { ours: string[]; brainReachable: boolean };
};

/** D9: the bucket for a run whose Connection no longer exists. */
export const UNATTRIBUTED_KEY = 'unattributed';
export const UNATTRIBUTED_LABEL = 'Unattributed (Connection deleted)';

/**
 * The two things the page must be able to say about OUR meter before it prints
 * a dollar figure. Rendered by the Spend page; kept here because they describe
 * the shape of the numbers this module produces.
 */
export const OURS_COVERAGE: readonly string[] = [
  "Ours meters the agent runner's model calls that traverse this deployment's own gateway.",
  'A run whose model could not be priced is counted in unpricedRuns and adds no dollar '
    + 'amount; a total of null means nothing in the window could be priced.',
];

/** A decimal string (the column is text so money never becomes a float) → number.
 *  `null`, missing and blank all stay `null` — never 0 (honesty rule 3). */
function parseCost(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The window predicate, shared by all three queries: `started_at >= now() - N days`. */
function withinWindow(days: number) {
  return sql`${schema.scheduleRuns.startedAt} >= now() - make_interval(days => ${days}::int)`;
}

/**
 * Group already-joined rows by `keyField` and sum their `costUsd`. A null/blank
 * key is the `unattributed` bucket and carries D9's own label. Deterministic
 * order: priced totals descending, then key ascending.
 */
export function rollup<T extends { costUsd: string | null }>(
  rows: readonly T[],
  keyField: keyof T & string,
  labelField: keyof T & string,
): SpendRow[] {
  const groups = new Map<string, { label: string; runs: number; costUsd: number | null; unpricedRuns: number }>();

  for (const row of rows) {
    const rawKey = row[keyField];
    const key = rawKey === null || rawKey === undefined || rawKey === ''
      ? UNATTRIBUTED_KEY
      : String(rawKey);
    const rawLabel = row[labelField];
    const label = key === UNATTRIBUTED_KEY
      ? UNATTRIBUTED_LABEL
      : (rawLabel === null || rawLabel === undefined || rawLabel === '' ? key : String(rawLabel));

    let group = groups.get(key);
    if (!group) {
      group = { label, runs: 0, costUsd: null, unpricedRuns: 0 };
      groups.set(key, group);
    }
    group.runs += 1;
    const cost = parseCost(row.costUsd);
    if (cost === null) group.unpricedRuns += 1;
    else group.costUsd = (group.costUsd ?? 0) + cost;
  }

  return [...groups.entries()]
    .map(([key, g]) => ({ key, label: g.label, runs: g.runs, costUsd: g.costUsd, unpricedRuns: g.unpricedRuns }))
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.key.localeCompare(b.key));
}

/**
 * The window's total across every run. If runs exist but NONE could be priced,
 * the total is `null`, never 0. No runs at all is an honest 0.
 */
function totalsOf(rows: SpendRow[]): { totalUsd: number | null; unpricedRuns: number } {
  const unpricedRuns = rows.reduce((sum, r) => sum + r.unpricedRuns, 0);
  const priced = rows.filter((r) => r.costUsd !== null);
  if (rows.length > 0 && priced.length === 0) return { totalUsd: null, unpricedRuns };
  return { totalUsd: priced.reduce((sum, r) => sum + (r.costUsd ?? 0), 0), unpricedRuns };
}

/** Per member. The member is reached through the Connection: a deleted
 *  Connection is `unattributed`, never a member with a blank name. */
export async function spendByMember(orgId: string, days: number): Promise<SpendRow[]> {
  const rows = await getDb().select({
    memberId: schema.memberships.userId,
    memberLabel: schema.users.email,
    costUsd: schema.agentRuns.costUsd,
  })
    .from(schema.agentRuns)
    .innerJoin(schema.scheduleRuns, eq(schema.agentRuns.runId, schema.scheduleRuns.id))
    .leftJoin(schema.connections, eq(schema.agentRuns.connectionId, schema.connections.id))
    .leftJoin(schema.memberships, eq(schema.connections.membershipId, schema.memberships.id))
    .leftJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .where(and(eq(schema.agentRuns.organizationId, orgId), withinWindow(days)));

  return rollup(rows, 'memberId', 'memberLabel');
}

/** Per schedule. `schedule_runs` cascades from `schedules`, so the join always
 *  resolves; the left-join shape keeps a null schedule from inventing one. */
export async function spendBySchedule(orgId: string, days: number): Promise<SpendRow[]> {
  const rows = await getDb().select({
    scheduleId: schema.schedules.id,
    scheduleLabel: schema.schedules.name,
    costUsd: schema.agentRuns.costUsd,
  })
    .from(schema.agentRuns)
    .innerJoin(schema.scheduleRuns, eq(schema.agentRuns.runId, schema.scheduleRuns.id))
    .leftJoin(schema.schedules, eq(schema.scheduleRuns.scheduleId, schema.schedules.id))
    .where(and(eq(schema.agentRuns.organizationId, orgId), withinWindow(days)));

  return rollup(rows, 'scheduleId', 'scheduleLabel');
}

/** Per model. A row here is one metered model CALL (`agent_run_usage` is the
 *  budget's authority and `agent_runs.cost_usd` is its rollup), so `runs` counts
 *  calls in this section, and an unpriced call is counted, never zeroed. */
export async function spendByModel(orgId: string, days: number): Promise<SpendRow[]> {
  const rows = await getDb().select({
    model: schema.agentRunUsage.model,
    modelLabel: schema.agentRunUsage.model,
    costUsd: schema.agentRunUsage.costUsd,
  })
    .from(schema.agentRunUsage)
    .innerJoin(schema.agentRuns, eq(schema.agentRunUsage.runId, schema.agentRuns.runId))
    .innerJoin(schema.scheduleRuns, eq(schema.agentRuns.runId, schema.scheduleRuns.id))
    .where(and(eq(schema.agentRuns.organizationId, orgId), withinWindow(days)));

  return rollup(rows, 'model', 'modelLabel');
}

/**
 * The whole report. Our three sections are assembled first; gbrain's ledger is
 * then read through `brainUsage`, and a failure there is NOT a page failure:
 * `brain` becomes null and `coverage.brainReachable` false. It is never
 * reported as zero, though — an unread ledger is unknown, not empty.
 */
export async function spendReport(orgId: string, days: number): Promise<SpendReport> {
  const [byMember, bySchedule, byModel] = await Promise.all([
    spendByMember(orgId, days),
    spendBySchedule(orgId, days),
    spendByModel(orgId, days),
  ]);

  let brain: BrainUsage | null = null;
  let brainReachable = true;
  try {
    brain = await brainUsage(days);
  } catch {
    brain = null;
    brainReachable = false;
  }

  return {
    windowDays: days,
    ours: { ...totalsOf(byMember), byMember, bySchedule, byModel },
    brain,
    coverage: { ours: [...OURS_COVERAGE], brainReachable },
  };
}
