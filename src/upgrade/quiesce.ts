import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UpgradeContext } from './types.ts';
import { callOps, auditTail as httpAuditTail } from '../control/opsClient.ts';

/** Stop order (D3): every writer drains before the last one — gbrain-ops —
 *  goes down, leaving Postgres as the only live process. resume() runs the
 *  reverse. */
export const QUIESCE_ORDER = [
  'scheduler', 'gbrain-worker', 'control-plane', 'gbrain-serve', 'gbrain-ops',
] as const;

/**
 * Generous, MEASURED bounds (L1), not the compose file's redeploy-tuned
 * defaults. `scheduler`'s compose `stop_grace_period` is 20s
 * (compose/docker-compose.yml:136) — right for a routine redeploy, wrong for
 * an upgrade quiesce: `executeRun` is always awaited to completion
 * (src/scheduler/main.ts, RECON) and a `dream` run can run up to 7200s. This
 * task does not make quiesce wait out a live run — that is Task 11
 * preflight's job (refuse the upgrade while a `schedule_runs` row is
 * `running`). This bound exists only so a run preflight already accepted as
 * short is never truncated by a race against quiesce's own SIGTERM.
 */
const STOP_GRACE_S: Record<(typeof QUIESCE_ORDER)[number], number> = {
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

/** Feed text to a command's stdin — argv array only; the text never reaches
 *  argv, so a credential in it is never a credential in `ps` (S3c). */
async function feedString(argv: string[], input: string, timeoutMs = 60_000) {
  const p = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    await p.stdin.write(input);
    await p.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

export type OpsCaller = {
  auditTail(lines: number): Promise<string[]>;
  supervisorStatus(): Promise<{ running: boolean; workers: unknown[] } | null>;
};

/** Direct HTTP, opsClient.ts's own convention. Works wherever ops publishes
 *  a reachable port — compose/docker-compose.dev.yml does, for Gate A and
 *  test/e2e. This is the default `verifySupervisorDrained` falls back to. */
function httpOpsCaller(): OpsCaller {
  return {
    auditTail: (lines) => httpAuditTail(lines),
    async supervisorStatus() {
      const r = await callOps<{ running?: boolean; workers?: unknown[] }>(
        'jobs.supervisorStatus', {}, { json: true, timeoutMs: 30_000 },
      );
      return r.json ? { running: !!r.json.running, workers: r.json.workers ?? [] } : null;
    },
  };
}

/**
 * Production-safe: reach ops through `compose exec -T gbrain-ops bun -e`,
 * the same relay scripts/restore.ts:170-182 already uses. Production
 * publishes no ops host port (S2), so a bare host-side fetch to
 * OPS_RPC_URL only works in dev/test, never here.
 */
function relayOpsCaller(compose: readonly string[]): OpsCaller {
  const relay = async <T>(path: string, body: unknown): Promise<T> => {
    const program = `
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      const base = process.env.OPS_RPC_URL ?? 'http://127.0.0.1:3140';
      const res = await fetch(base + ${JSON.stringify(path)}, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPS_RPC_TOKEN },
        body: input,
      });
      process.stdout.write(await res.text());
    `;
    const r = await feedString(
      [...compose, 'exec', '-T', 'gbrain-ops', 'bun', '-e', program], JSON.stringify(body),
    );
    if (r.exitCode !== 0) throw new Error(`ops relay ${path} failed: ${r.stderr}`);
    return JSON.parse(r.stdout) as T;
  };
  return {
    auditTail: async (lines) => {
      const r = await relay<{ lines?: string[] }>('/fileplane/audit-tail', { lines });
      return Array.isArray(r.lines) ? r.lines : [];
    },
    supervisorStatus: async () => {
      const r = await relay<{ json: { running?: boolean; workers?: unknown[] } | null }>(
        '/rpc', { op: 'jobs.supervisorStatus', params: {}, json: true, timeoutMs: 30_000 },
      );
      return r.json ? { running: !!r.json.running, workers: r.json.workers ?? [] } : null;
    },
  };
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

export type QuiesceEvidence = { stopped: string[]; proof: SupervisorDrainProof; elapsedMs: number };

/** Stop every writer, in order, leaving Postgres as the only live process (D3). */
export async function quiesce(ctx: QuiesceContext): Promise<QuiesceEvidence> {
  const compose = composeArgv(ctx);
  const t0 = Date.now();
  const stopped: string[] = [];
  let proof: SupervisorDrainProof | null = null;
  const ops = relayOpsCaller(compose);

  for (const svc of QUIESCE_ORDER) {
    const grace = STOP_GRACE_S[svc];
    // The quiesce window opens when the stop is REQUESTED; only audit events
    // at or after this instant may decide the drain verdict (a stale event
    // from an earlier cycle must not).
    const stopRequestedAt = new Date().toISOString();
    const r = await sh([...compose, 'stop', '-t', String(grace), svc], (grace + 30) * 1000);
    if (r.exitCode !== 0) throw new Error(`quiesce: stopping ${svc} failed: ${r.stderr}`);
    stopped.push(svc);
    // gbrain-ops and gbrain-worker share the gbrain-home volume, and ops
    // itself is not stopped until the LAST iteration of this loop — so this
    // read is still reachable right after the worker (the previous entry)
    // goes down.
    if (svc === 'gbrain-worker') proof = await verifySupervisorDrained({ ops, since: stopRequestedAt });
  }

  if (!proof) throw new Error('quiesce finished without ever verifying the supervisor drain');
  return { stopped, proof, elapsedMs: Date.now() - t0 };
}

/**
 * Bring services back up. `services` defaults to everything, but a caller
 * may resume exactly one — a first-class operation, not a special case.
 * `up -d`, not `start`: a pin swap changes the image tag a stopped
 * container would otherwise keep ignoring.
 */
export async function resume(
  ctx: QuiesceContext, services: readonly string[] = QUIESCE_ORDER,
): Promise<void> {
  const compose = composeArgv(ctx);
  const order = [...QUIESCE_ORDER].reverse().filter((svc) => services.includes(svc));
  for (const svc of order) {
    const r = await sh([...compose, 'up', '-d', '--no-deps', svc], 120_000);
    if (r.exitCode !== 0) throw new Error(`resume: starting ${svc} failed: ${r.stderr}`);
  }
}
