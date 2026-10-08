import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UpgradeContext } from './types.ts';
import { type OpsCaller, httpOpsCaller, relayOpsCaller } from '../control/opsCaller.ts';
export { type OpsCaller, httpOpsCaller, relayOpsCaller } from '../control/opsCaller.ts';

/** Stop order (D3, D13): every writer drains before the last one — gbrain-ops —
 *  goes down, leaving Postgres as the only live process. resume() runs the
 *  reverse.
 *
 *  `agent-runner` is FIRST (D13): it is the one consumer that keeps writing to
 *  the brain after the scheduler stops materializing — a harness holds its run
 *  open and writes pages through its own token — so it has to be down before
 *  anything that could materialize more work for it. It is also never a path to
 *  an upgrade (G5): `SWAP_SERVICES` (scripts/upgrade.ts) does not name it,
 *  because the runner image carries no gbrain binary and a pin move cannot
 *  rebuild it. Being behind the `runner` profile (D12, off by default) is not a
 *  contradiction — see `composeModel`/`drainLane` below for how a service this
 *  project does not have is handled. */
export const QUIESCE_ORDER = [
  'agent-runner', 'scheduler', 'gbrain-worker', 'control-plane', 'gbrain-serve', 'gbrain-ops',
] as const;

/**
 * Generous, MEASURED bounds (L1), not the compose file's redeploy-tuned
 * defaults. `scheduler`'s compose `stop_grace_period` is 20s
 * (compose/docker-compose.yml:136) — right for a routine redeploy, wrong for
 * an upgrade quiesce: `executeRun` is always awaited to completion
 * (src/scheduler/main.ts, RECON) and a `dream` run can run up to 7200s. This
 * task does not make quiesce wait out a live run — that is Task 11 preflight's
 * job (refuse the upgrade while a `schedule_runs` row is `running`). That check
 * was claimed here for a whole slice and did not exist; Slice 4 Task 14 added it
 * (`inFlightRuns` in scripts/upgrade.ts) and recorded it as a Slice 3.5 defect
 * this slice found (docs/slice-4-findings.md, merged from
 * local://finding-task14.md). This bound exists only so a run
 * preflight already accepted as short is never truncated by a race against
 * quiesce's own SIGTERM.
 */
const STOP_GRACE_S: Record<(typeof QUIESCE_ORDER)[number], number> = {
  // The runner's drain is a teardown, not a run, and it is deliberately not the
  // scheduler's 90 (that number exists because `executeRun` is awaited to
  // completion; the runner has no equivalent wait — preflight refuses the
  // upgrade while any run row is `running`, so nothing here is waiting a run
  // out). What is left at this stop: the claim loop ends on the signal, the
  // in-flight harness is SIGTERMed inside the runner's own bounded child grace,
  // and the run token is revoked through the control plane — which is still UP,
  // because the runner is FIRST in this order, so that revoke is one loopback
  // HTTP call rather than a service that has to come back. 60s is margin around
  // that teardown AND it is the service's own declared `stop_grace_period`
  // (D6), so quiesce's `-t` is never the tighter bound that SIGKILLs a drain
  // compose itself promises room for.
  'agent-runner': 60,
  scheduler: 90,
  'gbrain-worker': 90, // matches scripts/backup.ts's existing precedent exactly
  'control-plane': 30,
  // U12: AT THIS PIN, serve --http's server.close() has no timeout bound —
  // v0.50.5.0 adds a hard 5s one. Give margin in case it never fires cleanly.
  'gbrain-serve': 30,
  'gbrain-ops': 30,
};

/**
 * The context quiesce/resume consume. Task 11 enriched `UpgradeContext` with a
 * required `compose` prefix, so the former `& { compose?: readonly string[] }`
 * intersection became redundant and was removed (coordinator note 1). The
 * fallback in `composeArgv` stays as belt-and-braces for callers that pass an
 * empty prefix, but a real host CLI always supplies one.
 */
export type QuiesceContext = UpgradeContext;

const DEFAULT_COMPOSE = [
  'docker', 'compose',
  ...(existsSync('.env') ? ['--env-file', '.env'] : []),
  '-f', 'compose/docker-compose.yml',
];

function composeArgv(ctx: QuiesceContext): readonly string[] {
  return ctx.compose && ctx.compose.length > 0 ? ctx.compose : DEFAULT_COMPOSE;
}

/**
 * What this compose project has, from two questions that are NOT the same:
 *
 *  · `active` — `config --services`, the services in the active profile model
 *    (COMPOSE_PROFILES from the environment or from `.env`). This is what a
 *    resume may restore, and it is why a default deployment never ends up with
 *    the runner it never asked for.
 *  · `containers` — `ps -a --services`, the services with a container in this
 *    project whether or not their profile is active. A runner container can
 *    exist while its profile is off — `up -d --no-deps <profile-gated service>`
 *    STARTS it either way (measured) — and a live writer has to be drained
 *    whatever the profile says.
 *
 * `'unknown'` = the project could not be rendered. That is NOT the same as "no
 * services": a compose project that cannot be read is not evidence that a
 * writer is absent, so drainLane still stops every service in QUIESCE_ORDER.
 * That fallback is harmless even for a profile-gated member: `stop` of a
 * service whose profile is off exits 0 — it does NOT fail, so nothing
 * surfaces at the first stop that "cannot succeed" (measured:
 * `docker compose --env-file .env -f compose/docker-compose.yml stop -t 1
 * agent-runner` exits 0 with the runner profile off). restoreLane is the
 * direction that STARTS containers, and there the same profile-gated member
 * must be excluded even when the model is unknown: `up -d --no-deps` ignores
 * the profile and would switch the runner on (measured), so an unreadable
 * project must not become a path to it either.
 */
export type ComposeModel =
  | { active: ReadonlySet<string>; containers: ReadonlySet<string> }
  | 'unknown';

function serviceNames(stdout: string): ReadonlySet<string> {
  return new Set(stdout.split('\n').map((line) => line.trim()).filter(Boolean));
}

export async function composeModel(compose: readonly string[]): Promise<ComposeModel> {
  const [model, containers] = await Promise.all([
    sh([...compose, 'config', '--services'], 60_000),
    sh([...compose, 'ps', '-a', '--services'], 60_000),
  ]);
  if (model.exitCode !== 0) return 'unknown';
  const active = serviceNames(model.stdout);
  if (active.size === 0) return 'unknown';
  return { active, containers: containers.exitCode === 0 ? serviceNames(containers.stdout) : new Set() };
}

/**
 * What a quiesce has to stop on THIS project, in stop order: every service in
 * the order that the active model declares or that already has a container.
 * `docker compose stop <service this project does not have>` exits non-zero
 * ("no such service: agent-runner") and quiesce() throws on a non-zero stop, so
 * naming one unconditionally would break the upgrade lane on every deployment
 * without the runner — measured, not assumed.
 */
export function drainLane(
  model: ComposeModel, requested: readonly string[] = QUIESCE_ORDER,
): string[] {
  return QUIESCE_ORDER.filter((svc) => requested.includes(svc) && (
    model === 'unknown' || model.active.has(svc) || model.containers.has(svc)
  ));
}

/**
 * What a resume may start, in the reverse of the stop order (the last service
 * down comes back first). The active model ONLY, never `containers`: a runner
 * the operator's configuration excludes must not be switched on by an upgrade —
 * G5's rule read the other way round, because an upgrade is not a path to an
 * agent runner either.
 *
 * An `unknown` model is every requested service EXCEPT the profile-gated
 * runner: an unreadable project is not evidence that the operator enabled the
 * `runner` profile, and `up -d --no-deps agent-runner` would start it anyway
 * (measured) — the container that executes model-written code with the
 * organisation's key.
 */
export function restoreLane(
  model: ComposeModel, requested: readonly string[] = QUIESCE_ORDER,
): string[] {
  return QUIESCE_ORDER.filter((svc) => requested.includes(svc) && (
    model === 'unknown' ? svc !== 'agent-runner' : model.active.has(svc)
  )).reverse();
}

async function sh(argv: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

export type SupervisorAuditEvent = Record<string, unknown>;

export type SupervisorDrainProof = {
  clean: boolean;
  exitCode: number | null;
  reason: string | null;
  running: boolean | null;
  workers: unknown[];
  classification: 'clean' | 'crashed' | 'lock_lost' | 'unproven';
  /** ISO timestamp the quiesce window opened at: the moment the stop was
   *  requested, or `now - lookbackMs` when no `since` was supplied. */
  windowStart: string;
  /** ISO timestamp the verdict was computed. */
  windowEnd: string;
  /** The in-window audit event that decided the verdict, or null. Exposed so
   *  Gate C can print WHY a verdict was reached, not just the verdict. */
  decidingEvent: SupervisorAuditEvent | null;
};

/** A no-arg `verifySupervisorDrained()` (Gate A / Gate C's own call) still has
 *  to see the stop it just issued, so the window opens this far back when the
 *  caller does not name the stop instant. L1 measured a clean drain at 1150ms
 *  and the quiesce window at ~19s; 10 minutes is generous margin while still
 *  excluding the 35-minute-stale event that produced the original bug. */
export const DRAIN_LOOKBACK_MS = 600_000;

export type VerifyDrainedOptions = {
  /** Test-only: read audit lines from this LOCAL directory instead of
   *  fetching them through ops — Gate A's negative fixtures use this rather
   *  than inducing a real MAX_CRASHES in a live supervisor. */
  auditDir?: string;
  ops?: OpsCaller;
  /** ISO timestamp the stop was requested — the open of the quiesce window.
   *  Only audit events at or after it may decide the verdict, so a stale
   *  `stopped` from an earlier lock-lost episode cannot misclassify a later
   *  drain. Omitted => `now - lookbackMs`. */
  since?: string;
  /** Lookback used when `since` is omitted. Defaults to DRAIN_LOOKBACK_MS. */
  lookbackMs?: number;
};

async function readLocalAuditDir(dir: string): Promise<string[]> {
  const { readdir, readFile } = await import('node:fs/promises');
  const names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort();
  const lines: string[] = [];
  for (const name of names) {
    lines.push(...(await readFile(join(dir, name), 'utf8')).split('\n').filter((l) => l.trim() !== ''));
  }
  return lines;
}

/**
 * The load-bearing check (U9, honesty rule 3). The supervisor's OWN audit
 * log — cross-checked against `jobs supervisor status --json` — is the proof,
 * never `stop`'s `reason:'drained'` alone, which only means "the PID vanished
 * inside 40s".
 *
 * The verdict is WINDOW-SCOPED to the quiesce: only an event at or after the
 * stop request may decide it. That is what stops a stale `stopped` from an
 * earlier lock-lost episode deciding a later, unrelated drain — the misread
 * this fix was written for (the 23:45 lock-lost `stopped` sat in the tail and
 * classified a genuine 00:20 clean drain `lock_lost`).
 *
 * Classification is from a POSITIVE in-window signal, never from absence:
 *   - `clean`     : an in-window `shutting_down` with `exit_code:0`, or a
 *                   `stopped` with `exit_code:0` AND a SIGTERM/SIGINT reason,
 *                   AND `status` agreeing (`running===false`, no workers).
 *   - `lock_lost` : an in-window event whose `exit_code` is 4 (LOCK_LOST, L3)
 *                   or whose `reason` is `supervisor_lock_lost` — "someone
 *                   else owns this", never an undifferentiated crash.
 *   - `crashed`   : any other in-window non-zero exit code.
 *   - `unproven`  : the window holds no deciding event (or a positive event
 *                   the status contradicts). Absence of evidence is never a
 *                   pass; a contradictory signal is not a pass either.
 *
 * At 0.50.0.0 this matters concretely: a clean stop writes `shutting_down
 * {reason:'SIGTERM', exit_code:0}` and NO `stopped` at all (F1), so a
 * `stopped`-only reader reported `unproven` or, worse, inherited a stale
 * `stopped`. Reading `shutting_down` as the positive signal is not a weakening
 * — it is the event the clean path actually emits.
 *
 * `ts` note: gbrain always stamps audit rows with `ts`; a row without one is a
 * fixture/legacy line that cannot be placed in the window. It is still
 * allowed to decide (the plan's original unit fixtures carry no `ts`), but
 * every real row is dated and therefore genuinely windowed.
 */
export async function verifySupervisorDrained(
  opts: VerifyDrainedOptions = {},
): Promise<SupervisorDrainProof> {
  const ops = opts.ops ?? httpOpsCaller();
  const lines = opts.auditDir ? await readLocalAuditDir(opts.auditDir) : await ops.auditTail(50);
  const events = lines
    .map((l) => { try { return JSON.parse(l) as SupervisorAuditEvent; } catch { return null; } })
    .filter((e): e is SupervisorAuditEvent => e !== null);

  const windowEndMs = Date.now();
  const parsedSince = opts.since !== undefined ? Date.parse(opts.since) : NaN;
  const windowStartMs = Number.isFinite(parsedSince)
    ? parsedSince
    : windowEndMs - (opts.lookbackMs ?? DRAIN_LOOKBACK_MS);
  const windowStart = new Date(windowStartMs).toISOString();
  const windowEnd = new Date(windowEndMs).toISOString();

  const inWindow = (e: SupervisorAuditEvent): boolean => {
    const ts = typeof e.ts === 'string' ? Date.parse(e.ts) : NaN;
    // No parseable `ts` => fixture/legacy row; do not let a missing stamp
    // silently drop it (real rows are always stamped, so production stays
    // scoped). A dated row outside the window is excluded.
    return Number.isFinite(ts) ? ts >= windowStartMs : true;
  };

  const decisions = events.filter(
    (e) => (e.event === 'shutting_down' || e.event === 'stopped') && inWindow(e),
  );
  const deciding = decisions.length > 0 ? decisions[decisions.length - 1]! : null;

  const status = await ops.supervisorStatus();
  const running = status?.running ?? null;
  const workers = Array.isArray(status?.workers) ? status!.workers : [];

  const base = {
    running,
    workers,
    windowStart,
    windowEnd,
    decidingEvent: deciding,
  };

  if (!deciding) {
    return { ...base, clean: false, exitCode: null, reason: null, classification: 'unproven' };
  }

  const exitCode = typeof deciding.exit_code === 'number' ? deciding.exit_code : null;
  const reason = typeof deciding.reason === 'string' ? deciding.reason : null;

  if (exitCode === 4 || reason === 'supervisor_lock_lost') {
    return { ...base, clean: false, exitCode, reason, classification: 'lock_lost' };
  }
  if (exitCode !== null && exitCode !== 0) {
    return { ...base, clean: false, exitCode, reason, classification: 'crashed' };
  }

  const positive = deciding.event === 'shutting_down'
    ? exitCode === 0
    : deciding.event === 'stopped' && exitCode === 0 && (reason === 'SIGTERM' || reason === 'SIGINT');
  if (!positive) {
    return { ...base, clean: false, exitCode, reason, classification: 'unproven' };
  }

  const clean = running === false && workers.length === 0;
  return {
    ...base,
    clean,
    exitCode,
    reason,
    classification: clean ? 'clean' : 'unproven',
  };
}

/** `stopped` is the lane's whole ORDER, including a service this project does
 *  not have (behind a profile the operator never enabled): the evidence is that
 *  every writer in the order is down, and one that was never up is trivially
 *  down. What was actually issued a stop is `drainLane(model)`; Gate C's
 *  journal assertion and test/integration/quiesce.test.ts both pin this list to
 *  QUIESCE_ORDER. */
export type QuiesceEvidence = { stopped: string[]; proof: SupervisorDrainProof; elapsedMs: number };

/** Stop every writer, in order, leaving Postgres as the only live process (D3). */
export async function quiesce(ctx: QuiesceContext): Promise<QuiesceEvidence> {
  const compose = composeArgv(ctx);
  const t0 = Date.now();
  const stopped: string[] = [];
  let proof: SupervisorDrainProof | null = null;
  const ops = relayOpsCaller(compose);
  // Resolved BEFORE the first stop, while compose can still answer.
  const lane = drainLane(await composeModel(compose));

  for (const svc of QUIESCE_ORDER) {
    const grace = STOP_GRACE_S[svc];
    if (lane.includes(svc)) {
      // The quiesce window opens when the stop is REQUESTED; only audit events
      // at or after this instant may decide the drain verdict (a stale event
      // from an earlier cycle must not).
      const stopRequestedAt = new Date().toISOString();
      const r = await sh([...compose, 'stop', '-t', String(grace), svc], (grace + 30) * 1000);
      if (r.exitCode !== 0) throw new Error(`quiesce: stopping ${svc} failed: ${r.stderr}`);
      // gbrain-ops and gbrain-worker share the gbrain-home volume, and ops
      // itself is not stopped until the LAST iteration of this loop — so this
      // read is still reachable right after the worker (the previous entry)
      // goes down.
      if (svc === 'gbrain-worker') proof = await verifySupervisorDrained({ ops, since: stopRequestedAt });
    }
    stopped.push(svc);
  }

  if (!proof) throw new Error('quiesce finished without ever verifying the supervisor drain');
  return { stopped, proof, elapsedMs: Date.now() - t0 };
}

/**
 * Stop a subset of the quiesce lane after a passing doctor gate. The gate
 * has to see the same writers the baseline saw; this is the hold that follows
 * that score, not a reason to leave them down during it. A service the
 * project does not have is skipped, same as quiesce (`drainLane`).
 */
export async function stopServices(
  ctx: QuiesceContext, services: readonly string[],
): Promise<string[]> {
  const compose = composeArgv(ctx);
  const lane = drainLane(await composeModel(compose), services);
  const stopped: string[] = [];
  for (const svc of lane) {
    // drainLane only returns QUIESCE_ORDER members, which are the grace keys.
    const grace = STOP_GRACE_S[svc as (typeof QUIESCE_ORDER)[number]];
    const r = await sh([...compose, 'stop', '-t', String(grace), svc], (grace + 30) * 1000);
    if (r.exitCode !== 0) throw new Error(`stop: stopping ${svc} failed: ${r.stderr}`);
    stopped.push(svc);
  }
  return stopped;
}

/**
 * Bring services back up. `services` defaults to everything, but a caller
 * may resume exactly one — a first-class operation, not a special case.
 * `up -d`, not `start`: a pin swap changes the image tag a stopped
 * container would otherwise keep ignoring.
 *
 * What is restored is the ACTIVE model (`restoreLane`), so a service behind a
 * profile the operator never enabled is not started by an upgrade: `up -d
 * --no-deps` would start a profile-gated service either way (measured), which
 * would turn the agent runner on for a deployment that chose not to have one.
 */
export async function resume(
  ctx: QuiesceContext, services: readonly string[] = QUIESCE_ORDER,
): Promise<void> {
  const compose = composeArgv(ctx);
  const order = restoreLane(await composeModel(compose), services);
  for (const svc of order) {
    const r = await sh([...compose, 'up', '-d', '--no-deps', svc], 120_000);
    if (r.exitCode !== 0) throw new Error(`resume: starting ${svc} failed: ${r.stderr}`);
  }
}
