/**
 * The runner lane's presence, derived from what the control plane can HONESTLY
 * observe. Honesty rule 8: "the runner is enabled" is not "the runner is
 * connected".
 *
 * The control plane cannot read a compose profile — `agent-runner` is
 * profile-gated (D12) and may simply not exist — so the states are derived from
 * the two facts it does have: the environment, and the run ledger. The mapping,
 * explicit rather than implied:
 *
 *   disabled       `RUNNER_TOKEN` is unset or empty. Empty is not a missing
 *                  detail: an empty bearer must never authenticate (two empty
 *                  strings would pass `timingSafeEqual`), so empty IS the lane
 *                  being off — the configuration fact and the refusal are the
 *                  same fact. Compose interpolates `${RUNNER_TOKEN:-}` on both
 *                  the runner and the control plane, so this is the state a
 *                  runner-less deployment is in.
 *   never_claimed  The lane is configured and no claim is live. Either no runner
 *                  has ever claimed, or the last one's lease lapsed. It is the
 *                  lane's "no consumer is connected right now" state.
 *   connected      A claim is live: an `agent_prompt` run whose lease has not
 *                  expired — a `running` row inside its lease, or a claim /
 *                  heartbeat whose lease is still in the future. The ONLY green
 *                  state.
 *
 * Honesty rule 8 names three states and there is no fourth word for "configured,
 * claimed once, lease since lapsed", so that case reports `never_claimed` — and
 * `lastSeenAt` is the honest discriminator: `null` means literally never, a
 * timestamp means a runner was here and is not any more. A renderer must read
 * both fields; on `state` alone it would call a deployment that ran work
 * yesterday "never claimed".
 *
 * `version` is always `null`, and that is the honest answer rather than a gap
 * left open. The ledger records WHO claimed — `schedule_runs.claimed_by` is the
 * runner's `${HOSTNAME}-${uuid8}` id — and never which harness build. The
 * harness version lives on `agent_runs.harness_version`, written by the claim
 * path, and this probe deliberately does not read a row nothing has written yet:
 * a fabricated version is worse than an absent one, and an absent one is
 * visibly absent.
 *
 * Both queries filter on `schedules.jobType = 'agent_prompt'`, because the
 * SCHEDULER claims rows in this same ledger. A probe that counted those would
 * report a connected runner on a deployment that has none.
 */
import { and, desc, eq, gt, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '../control/db/client.ts';

export type RunnerState = 'disabled' | 'never_claimed' | 'connected';

export type RunnerStatus = {
  state: RunnerState;
  /** The most recent claim's moment. `null` when no runner has EVER claimed. */
  lastSeenAt: Date | null;
  /** Always `null` today — see the module comment. Never a fabricated value. */
  version: string | null;
};

/**
 * The one definition of "the lane is configured". Whitespace is not a
 * credential: a token that trims to nothing cannot authenticate, so it is the
 * lane being off, not a runner waiting for work.
 */
export function runnerTokenConfigured(
  token: string | undefined = process.env.RUNNER_TOKEN,
): boolean {
  return (token ?? '').trim() !== '';
}

/**
 * Three states, one of them green. Never throws on a missing ledger row and
 * never guesses: `/api/health` is the compose healthcheck, and a probe that
 * cannot answer must say so rather than claim connectivity.
 */
export async function runnerStatus(nowMs: number = Date.now()): Promise<RunnerStatus> {
  if (!runnerTokenConfigured()) return { state: 'disabled', lastSeenAt: null, version: null };

  const db = getDb();

  const [last] = await db.select({ startedAt: schema.scheduleRuns.startedAt })
    .from(schema.scheduleRuns)
    .innerJoin(schema.schedules, eq(schema.schedules.id, schema.scheduleRuns.scheduleId))
    .where(and(
      eq(schema.schedules.jobType, 'agent_prompt'),
      isNotNull(schema.scheduleRuns.claimedBy),
    ))
    .orderBy(desc(schema.scheduleRuns.startedAt))
    .limit(1);

  // "Within the lease window" is the timestamp, not the row's state: a runner
  // that finished a run twenty seconds ago still holds its lease and is the same
  // runner that will claim the next one. A heartbeat only moves this column, so
  // an in-flight run keeps it in the future for as long as the runner is alive.
  const [live] = await db.select({ id: schema.scheduleRuns.id })
    .from(schema.scheduleRuns)
    .innerJoin(schema.schedules, eq(schema.schedules.id, schema.scheduleRuns.scheduleId))
    .where(and(
      eq(schema.schedules.jobType, 'agent_prompt'),
      isNotNull(schema.scheduleRuns.claimedBy),
      gt(schema.scheduleRuns.leaseExpiresAt, new Date(nowMs)),
    ))
    .limit(1);

  return {
    state: live ? 'connected' : 'never_claimed',
    lastSeenAt: last?.startedAt ?? null,
    version: null,
  };
}
