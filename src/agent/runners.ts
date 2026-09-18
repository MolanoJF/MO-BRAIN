/**
 * The runner lane's presence, derived from what the control plane can HONESTLY
 * observe. Honesty rule 8: "the runner is enabled" is not "the runner is
 * connected".
 *
 * The control plane cannot read a compose profile — `agent-runner` is
 * profile-gated (D12) and may simply not exist — so the states are derived from
 * the facts it does have: the environment, the run ledger, and the runner's own
 * long-poll. The mapping, explicit rather than implied:
 *
 *   disabled       `RUNNER_TOKEN` is unset or empty. Empty is not a missing
 *                  detail: an empty bearer must never authenticate (two empty
 *                  strings would pass `timingSafeEqual`), so empty IS the lane
 *                  being off — the configuration fact and the refusal are the
 *                  same fact. Compose interpolates `${RUNNER_TOKEN:-}` on both
 *                  the runner and the control plane, so this is the state a
 *                  runner-less deployment is in.
 *   never_claimed  The lane is configured and no runner has been SEEN in the
 *                  last `RUNNER_SEEN_WINDOW_MS`: either no runner has ever
 *                  polled the claim route, or the last one has stopped polling.
 *                  A run whose lease is live is also a sighting (below), so this
 *                  is the lane's "no consumer is connected right now" state.
 *   connected      A runner is there: either one was seen within the window, or
 *                  an `agent_prompt` run's lease is still in the future. The
 *                  ONLY green state.
 *
 * D2: what "seen" means is `runner_presence` — the row the claim route upserts
 * on EVERY long-poll, before it claims anything. A runner that polls and finds
 * no work has still announced itself, and calling that deployment "never
 * claimed" (the pre-D2 reading, which required a live lease) is a false refusal
 * about a runner that is knocking right now.
 *
 * WHY THE WINDOW CANNOT BE SHORTER THAN ONE POLL, and why it is exactly two:
 * `POST /api/runs/claim` holds the request for up to `RUN_CLAIM_WAIT_MS`
 * (25 s), answers `204`, and the runner loops immediately. Presence is written
 * when the request ARRIVES, so a healthy idle runner refreshes its row once per
 * poll — roughly every 25 s, not every second. A window at or under one poll
 * would therefore report `never_claimed` about a runner that is holding a poll
 * open at that very moment; two polls (`RUNNER_SEEN_WINDOW_MS`) tolerates one
 * whole missed or failed poll, which is the least a transient blip may cost. It
 * is deliberately not longer: a window of minutes would keep a dead runner
 * green. The in-run gap is not this window's job — a runner that is RUNNING
 * work is not polling, and the live lease (`lease_expires_at`, the same
 * deadline-shaped fact the scheduler claims with) is what says so.
 *
 * Honesty rule 8 names three states and there is no fourth word for "configured,
 * seen once, since stopped", so that case reports `never_claimed` — and
 * `lastSeenAt` is the honest discriminator: `null` means literally never, a
 * timestamp means a runner was here and is not any more. A renderer must read
 * both fields; on `state` alone it would call a deployment that ran work
 * yesterday "never claimed".
 *
 * `version` is what the last-seen runner reported in the very request that
 * recorded it (D4's `harnessVersion`), and `null` only when no runner has ever
 * been seen. It is the LAST SIGHTING's version, not a claim about the build
 * running now — a runner that upgrades and polls again replaces it.
 *
 * Both ledger queries filter on `schedules.jobType = 'agent_prompt'`, because
 * the SCHEDULER claims rows in this same ledger. A probe that counted those
 * would report a connected runner on a deployment that has none.
 */
import { and, desc, eq, gt, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '../control/db/client.ts';
import { RUN_CLAIM_WAIT_MS } from './claim.ts';

export type RunnerState = 'disabled' | 'never_claimed' | 'connected';

export type RunnerStatus = {
  state: RunnerState;
  /** The most recent sighting of a runner. `null` when none has EVER been seen. */
  lastSeenAt: Date | null;
  /** The harness version the last-seen runner reported; `null` until one is seen. */
  version: string | null;
};

/**
 * How long a sighting keeps the lane green. Two held polls (see the module
 * comment): the runner's own long-poll is the pulse, so the window has to
 * outlast one poll or it would blink on a healthy runner.
 */
export const RUNNER_SEEN_WINDOW_MS = 2 * RUN_CLAIM_WAIT_MS;

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
 * D2's seen-signal: the claim request itself. `POST /api/runs/claim` calls this
 * before anything is claimed, so a runner that polls and finds no work is
 * recorded as present — which is exactly the fact the old `never_claimed` was
 * wrong about.
 *
 * A request carrying no runner id, or no harness version, records NOTHING: both
 * are refused as request shape (`runner_never_seen`,
 * `harness_version_required`), and a sighting with neither an identity nor a
 * version is not a runner announcing itself — recording it would put an empty
 * string in `/api/health`'s `version`.
 *
 * Upsert, not insert: one row per runner, and the newest truth wins. A runner
 * that restarts with a new `${HOSTNAME}-${uuid8}` id adds a row rather than
 * overwriting the old one; both are sightings, and both age out the same way.
 */
export async function recordRunnerSeen(
  runnerId: string,
  harnessVersion: string,
  nowMs: number = Date.now(),
): Promise<void> {
  const id = runnerId.trim();
  const version = harnessVersion.trim();
  if (!id || !version) return;
  const at = new Date(nowMs);
  await getDb().insert(schema.runnerPresence)
    .values({ runnerId: id, lastSeenAt: at, harnessVersion: version })
    .onConflictDoUpdate({
      target: [schema.runnerPresence.runnerId],
      set: { lastSeenAt: at, harnessVersion: version },
    });
}

/**
 * Three states, one of them green. Never throws on a missing ledger row and
 * never guesses: `/api/health` is the compose healthcheck, and a probe that
 * cannot answer must say so rather than claim connectivity.
 */
export async function runnerStatus(nowMs: number = Date.now()): Promise<RunnerStatus> {
  if (!runnerTokenConfigured()) return { state: 'disabled', lastSeenAt: null, version: null };

  const db = getDb();

  // Three independent facts, one wall-clock round: the sighting record, the
  // last claim (the fallback that keeps `lastSeenAt` from claiming "never" about
  // a runner that was here before this table existed), and whether a lease is
  // live. They are read in parallel because `/api/health` is hot and their
  // order does not matter.
  const [presence, lastClaim, live] = await Promise.all([
    db.select({
      lastSeenAt: schema.runnerPresence.lastSeenAt,
      harnessVersion: schema.runnerPresence.harnessVersion,
    })
      .from(schema.runnerPresence)
      .orderBy(desc(schema.runnerPresence.lastSeenAt))
      .limit(1),
    db.select({ startedAt: schema.scheduleRuns.startedAt })
      .from(schema.scheduleRuns)
      .innerJoin(schema.schedules, eq(schema.schedules.id, schema.scheduleRuns.scheduleId))
      .where(and(
        eq(schema.schedules.jobType, 'agent_prompt'),
        isNotNull(schema.scheduleRuns.claimedBy),
      ))
      .orderBy(desc(schema.scheduleRuns.startedAt))
      .limit(1),
    // "Within the lease window" is the timestamp, not the row's state: a runner
    // that finished a run twenty seconds ago still holds its lease and is the same
    // runner that will claim the next one. A heartbeat only moves this column, so
    // an in-flight run keeps it in the future for as long as the runner is alive.
    db.select({ id: schema.scheduleRuns.id })
      .from(schema.scheduleRuns)
      .innerJoin(schema.schedules, eq(schema.schedules.id, schema.scheduleRuns.scheduleId))
      .where(and(
        eq(schema.schedules.jobType, 'agent_prompt'),
        isNotNull(schema.scheduleRuns.claimedBy),
        gt(schema.scheduleRuns.leaseExpiresAt, new Date(nowMs)),
      ))
      .limit(1),
  ]);

  const seen = presence[0] ?? null;
  const seenNow = seen !== null
    && nowMs - seen.lastSeenAt.getTime() <= RUNNER_SEEN_WINDOW_MS;

  // The sighting record when there is one, the last claim otherwise, and the
  // later of the two: `lastSeenAt` never moves backwards and never becomes
  // `null` once a runner has been here.
  const moments = [seen?.lastSeenAt, lastClaim[0]?.startedAt]
    .filter((at): at is Date => at !== undefined);

  return {
    state: live.length > 0 || seenNow ? 'connected' : 'never_claimed',
    lastSeenAt: moments.length === 0
      ? null
      : new Date(Math.max(...moments.map((at) => at.getTime()))),
    version: seen?.harnessVersion ?? null,
  };
}
