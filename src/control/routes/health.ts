import { Hono } from 'hono';
import { desc, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { opsHealthy, callOps, inspectRepos } from '../opsClient.ts';
import { GBRAIN_PIN, verifyRuntimePin, type PinVerification } from '../../contracts/pin.ts';
import { runnerStatus, runnerTokenConfigured, type RunnerStatus } from '../../agent/runners.ts';

export const health = new Hono();

/**
 * gbrain `sources status --json` returns an envelope object
 * (`{ schema_version, generated_at, sources, … }`), not a top-level array.
 * Accept a bare array too in case the shape ever flattens.
 */
export function reposFromSourcesStatus(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object' && Array.isArray((json as { sources?: unknown }).sources)) {
    return (json as { sources: unknown[] }).sources;
  }
  return [];
}

/** `/api/health` has no caller, so every personal Space is omitted — including
 *  one that would be the requester's own zone on an authenticated route. */
export function omitPersonalRepos<T extends { sourceId: string }>(
  repos: readonly T[],
  personalSourceIds: ReadonlySet<string>,
): T[] {
  return repos.filter((repo) => !personalSourceIds.has(repo.sourceId));
}

/**
 * Unacknowledged schedule alerts, KINDS ONLY.
 *
 * `/api/health` is reachable without a session — it is the compose healthcheck
 * — so `detail` must never appear here: a `push_blocked` detail can name a file
 * path that matched a secret scan, and a `connection_revoked` detail names a
 * client. Kinds and counts are what a healthcheck needs; the operators get the
 * details from the authenticated `/api/schedule-alerts`.
 */
async function openAlerts(): Promise<
  Array<{ id: string; kind: string; scheduleId: string | null; at: Date }>
> {
  try {
    return await getDb()
      .select({
        id: schema.scheduleAlerts.id,
        kind: schema.scheduleAlerts.kind,
        scheduleId: schema.scheduleAlerts.scheduleId,
        at: schema.scheduleAlerts.at,
      })
      .from(schema.scheduleAlerts)
      .where(isNull(schema.scheduleAlerts.acknowledgedAt))
      .orderBy(desc(schema.scheduleAlerts.at))
      .limit(20);
  } catch {
    // A health endpoint reports; it never 500s because one probe failed.
    return [];
  }
}

/**
 * The runner lane's three states (honesty rule 8), KINDS ONLY — the same
 * discipline `openAlerts()` follows and for the same reason: `/api/health` is
 * unauthenticated, so no token, no client id and no connection detail may
 * appear here. `state`, `lastSeenAt` and `version` are the whole vocabulary
 * D12 defines, and there is nothing else to leak.
 *
 * `version` is real since D2: it is the harness version the last-seen runner
 * reported in the very claim request that recorded it, and it is the same
 * string that container announces on the wire — not a runner id, not a token.
 * The runner's own identity (`runner_presence.runner_id`) is deliberately NOT
 * projected here.
 *
 * A ledger this probe cannot read is not a connected runner: the fallback is the
 * env-only reading, which is never green, and `components.controlDb` already
 * reports the failure that caused it.
 */
async function safeRunnerStatus(dbReadable: boolean): Promise<RunnerStatus> {
  if (!dbReadable) return { state: 'never_claimed', lastSeenAt: null, version: null };
  try {
    return await runnerStatus();
  } catch {
    return {
      state: runnerTokenConfigured() ? 'never_claimed' : 'disabled',
      lastSeenAt: null,
      version: null,
    };
  }
}

health.get('/health', async (c) => {
  const components: Record<string, 'ok' | 'down'> = { controlDb: 'down', ops: 'down' };

  try { await getDb().execute(sql`select 1`); components.controlDb = 'ok'; } catch { /* reported as down */ }

  // F14: this used to also `await callOps('toolsJson', …)` and discard the
  // result. It was an extra `gbrain --tools-json` process on the ops side per
  // call — measured 2.6–4.5 s and a 171 870-byte body — on an endpoint served
  // without a session, and it reported nothing: `components.ops` is
  // `opsHealthy()`'s verdict, and the two probes below already fail visibly
  // when the RPC lane is down (`pin.observed`/`pin.matches` null, `repos`
  // empty). Removing it is a Slice 3 defect fix, not a change of contract.
  if (await opsHealthy()) components.ops = 'ok';

  let pin: PinVerification = { declared: GBRAIN_PIN, observed: null, matches: null };
  if (components.ops === 'ok') {
    try { pin = await verifyRuntimePin(callOps); } catch { /* stays unverifiable */ }
  }

  // inspectRepos: stale index.lock plus uncommitted/unpushed drift. Sync
  // imports commits, not the working tree, so uncommitted files are pages
  // the brain cannot see yet. Personal Space directories live under the same
  // root; without a session this probe cannot keep "own zone" either. If the
  // control DB cannot name them, publish no source ids rather than all of them.
  let repos: unknown[] = [];
  if (components.ops === 'ok' && components.controlDb === 'ok') {
    try {
      const all = await inspectRepos();
      const personal = new Set(
        (await getDb().select({ sourceId: schema.spaces.sourceId }).from(schema.spaces)
          .where(isNotNull(schema.spaces.ownerMembershipId)))
          .map((row) => row.sourceId),
      );
      repos = omitPersonalRepos(all, personal);
    } catch { repos = []; }
  }

  const ok = Object.values(components).every((s) => s === 'ok');
  const scheduleAlerts = components.controlDb === 'ok' ? await openAlerts() : [];
  const runner = await safeRunnerStatus(components.controlDb === 'ok');
  // Never include a connection string, a token or an env dump here.
  return c.json(
    {
      ok, components, gbrainVersion: GBRAIN_PIN, pin, repos, scheduleAlerts, runner,
      at: new Date().toISOString(),
    },
    ok ? 200 : 503,
  );
});
