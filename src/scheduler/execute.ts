import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { OPERATIONS } from '../contracts/registry.ts';
import { buildArgv, redactArgv } from '../contracts/argv.ts';
import { getDb, schema } from '../control/db/client.ts';
import { callOps, cancelRun, writeReport } from '../control/opsClient.ts';
import { SCHEDULER_COMMANDS, fenceParams, validateParams, type SchedulerCommand } from './commands.ts';
import { drainHeldNotifications } from './briefing.ts';
import { finishRun, heartbeat, type ClaimedRun } from './claim.ts';
import { renderReport, type ReportStep } from './report.ts';
import { inQuietHours, reportStamp } from './time.ts';

export type Classification =
  | 'ok' | 'failed' | 'blocked' | 'conflict' | 'lock_lost' | 'timeout' | 'cancelled' | 'refused';

type ScheduleRow = typeof schema.schedules.$inferSelect;

/** How often a live run re-takes its lease while gbrain is working. */
const HEARTBEAT_MS = 15_000;

/**
 * Exit codes carry meaning; collapsing them into "failed" throws away the
 * operator's only diagnosis.
 *
 *  - 4 is LOCK_LOST. gbrain's supervisor defines ExitCodes.LOCK_LOST = 4
 *    ("#1849: the queue-scoped DB lock was lost mid-run"), undocumented in the
 *    roadmap's V5 row and absent from every contract test until Slice 0 found
 *    it. It means someone else owns this now — not a crash.
 *  - 143 is 128+SIGTERM: our own timeout killed the child.
 *  - sources push maps 5 to blocked/refused and 1 to conflict/failure; a
 *    non-fast-forward arrives as status 'push_failed' on exit 1 and must
 *    surface as an alert, never a swallow.
 */
export function classifyExit(commandId: string, exitCode: number, payload: unknown): Classification {
  if (exitCode === 0) return 'ok';
  if (exitCode === 4) return 'lock_lost';
  if (exitCode === 143) return 'timeout';

  if (commandId === 'sources-push') {
    const status = payload && typeof payload === 'object'
      ? (payload as { status?: unknown }).status : undefined;
    if (exitCode === 5) return status === 'refused_visibility' ? 'refused' : 'blocked';
    if (exitCode === 1) {
      if (status === 'pull_conflict' || status === 'push_failed') return 'conflict';
      return 'failed';
    }
  }
  return 'failed';
}

export type ExecuteDeps = {
  callOps: typeof callOps;
  writeReport: typeof writeReport;
  cancelRun: typeof cancelRun;
  now: () => number;
};

const defaultDeps: ExecuteDeps = { callOps, writeReport, cancelRun, now: () => Date.now() };

/** One command's outcome inside an occurrence. */
type Step = {
  command: SchedulerCommand;
  params: Record<string, string | boolean>;
  argv: string[];
  exitCode: number;
  payload: unknown;
  stdout: string;
  stderr: string;
  classification: Classification;
};

/**
 * "The worse of the two steps" needs a total order, and the order is operator
 * urgency, not alphabetical: a lost lock or a timeout means the run's own
 * safety net fired and outranks a plain failure; `cancelled` outranks only
 * `ok`, because a cancelled step says nothing about the step that never ran.
 */
const SEVERITY: Record<Classification, number> = {
  ok: 0, cancelled: 1, refused: 2, blocked: 3, conflict: 4, failed: 5, lock_lost: 6, timeout: 7,
};

function worst(steps: Step[]): Classification {
  let out: Classification = 'ok';
  for (const s of steps) {
    if (SEVERITY[s.classification] > SEVERITY[out]) out = s.classification;
  }
  return out;
}

/**
 * How much the occurrence changed, for report_policy 'on_change_or_failure'.
 * null means UNKNOWN and is never treated as "nothing happened" — the caller
 * writes the report (S3c: a dropped report is worse than a noisy one).
 * Across steps: unknown in ANY step makes the whole run unknown.
 */
function combinedChange(steps: Step[]): number | null {
  let total = 0;
  for (const s of steps) {
    const n = s.command.changeCount(s.payload);
    if (n === null) return null;
    total += n;
  }
  return total;
}

/**
 * The ordered steps one occurrence runs. Everything but `live-sync` is a single
 * step.
 *
 * `live-sync` is a TWO-STEP operation on ONE schedule (Task 18): the roadmap's
 * sub-hourly limit allows one such lane per org, and sync without embed leaves
 * the brain stale ("imports new commits ... and embeds anything stale"). It is
 * the only multi-step command, so it is a specific branch — not a pipeline.
 * Step 2 runs only on `ok`, under the same Connection fence, the same run row
 * and one combined report.
 */
function planSteps(
  schedule: ScheduleRow, command: SchedulerCommand, writeSourceId: string,
): { command: SchedulerCommand; params: Record<string, string | boolean> }[] {
  const stored = (schedule.params ?? {}) as Record<string, unknown>;
  const first = {
    command,
    params: fenceParams(command, validateParams(command, stored), writeSourceId),
  };
  if (schedule.preset !== 'live-sync' || command.id !== 'sync') return [first];

  const embed = SCHEDULER_COMMANDS['embed'];
  if (!embed) throw new Error('scheduler command embed is missing from the allowlist');
  return [first, { command: embed, params: fenceParams(embed, validateParams(embed, { stale: true }), writeSourceId) }];
}

/** Run one step as the Connection. A thrown op is a failure, never a silent pass. */
async function runStep(
  step: { command: SchedulerCommand; params: Record<string, string | boolean> },
  timeoutMs: number,
  runId: string,
  deps: ExecuteDeps,
): Promise<Step> {
  const spec = OPERATIONS[step.command.operation]!;
  const argv = redactArgv(spec, ['gbrain', ...buildArgv(spec, step.params, { json: step.command.json })]);

  let exitCode = -1;
  let payload: unknown = null;
  let stdout = '';
  let stderr = '';
  try {
    const r = await deps.callOps(step.command.operation, step.params, {
      json: step.command.json, timeoutMs, runId,
    });
    exitCode = r.exitCode;
    payload = r.json;
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (e) {
    // The op never produced an exit code: -1 classifies as a plain failure.
    stderr = e instanceof Error ? e.message : String(e);
  }

  return {
    command: step.command,
    params: step.params,
    argv,
    exitCode,
    payload,
    stdout,
    stderr,
    classification: classifyExit(step.command.id, exitCode, payload),
  };
}

/**
 * Run one claimed occurrence as its Connection.
 *
 * What the Connection buys us: the --source fence, the write Space the report
 * lands in, the git identity on the report commit, and the audit subject. What
 * it does NOT buy: gbrain-side enforcement. V1 put the control surface outside
 * the MCP operation registry, so this executes as gbrain-ops's local admin. The
 * UI says so; so does the report.
 */
export async function executeRun(
  claimed: ClaimedRun, deps: ExecuteDeps = defaultDeps,
): Promise<{ classification: Classification; reportPath: string | null }> {
  const db = getDb();
  const { run, schedule } = claimed;

  // The `morning-briefing` schedule runs no gbrain command — it releases what
  // quiet hours held. It short-circuits HERE, before the SCHEDULER_COMMANDS
  // lookup, which would refuse the operation as unknown. A specific branch, not
  // a pipeline step: there is no argv to run and no exit code to classify.
  if (schedule.operation === 'morning-briefing') {
    return runBriefing(schedule, run, deps);
  }

  const command: SchedulerCommand | undefined = schedule.operation
    ? SCHEDULER_COMMANDS[schedule.operation]
    : undefined;
  if (!command) {
    await fail(run.id, schedule, 'refused', schedule.operation
      ? `unknown scheduler command ${schedule.operation}`
      : 'gbrain_command run has no operation — a shape_matches_job_type violation');
    return { classification: 'refused', reportPath: null };
  }

  const context = await loadContext(schedule);
  if ('error' in context) {
    await fail(run.id, schedule, 'refused', context.error);
    return { classification: 'refused', reportPath: null };
  }
  const { org, connection, writeSpace, actor } = context;

  let planned: { command: SchedulerCommand; params: Record<string, string | boolean> }[];
  try {
    planned = planSteps(schedule, command, writeSpace.sourceId);
  } catch (e) {
    // A stored param the allowlist refuses (a fenced one, an unknown one) is a
    // configuration error, not a gbrain failure: refuse before spending anything.
    await fail(run.id, schedule, 'refused', e instanceof Error ? e.message : String(e));
    return { classification: 'refused', reportPath: null };
  }

  const timeoutSeconds = schedule.timeoutSeconds;
  const beat = setInterval(() => {
    void heartbeat(run.id, run.claimedBy ?? '', deps.now()).then(async (held) => {
      if (held) return;
      // Either the lease was reclaimed or kill_previous cancelled us.
      const [fresh] = await db.select({ cancel: schema.scheduleRuns.cancelRequested })
        .from(schema.scheduleRuns).where(eq(schema.scheduleRuns.id, run.id));
      if (fresh?.cancel) await deps.cancelRun(run.id);
    });
  }, HEARTBEAT_MS);

  const startedAt = new Date(run.startedAt?.getTime() ?? deps.now());
  const steps: Step[] = [];
  try {
    for (const step of planned) {
      const result = await runStep(step, timeoutSeconds * 1000, run.id, deps);
      steps.push(result);
      // The second step of `live-sync` runs only on success: embedding a
      // half-imported Space would commit chunks of a state sync never reached.
      if (result.classification !== 'ok') break;
    }
  } finally {
    clearInterval(beat);
  }

  // kill_previous (claim.ts) marks the victim row cancelled WHILE its child is
  // still running, so the exit code we observe is 128+SIGTERM. Without this read
  // a deliberately cancelled run finishes as `timeout` and raises a run_timeout
  // alert for a run an operator chose to end.
  const [after] = await db.select({ cancel: schema.scheduleRuns.cancelRequested })
    .from(schema.scheduleRuns).where(eq(schema.scheduleRuns.id, run.id));
  const classification: Classification = after?.cancel ? 'cancelled' : worst(steps);
  // The step that decided the outcome carries the headline: its exit code, its
  // payload (what the summary's `status` reads), and its argv.
  const decisive = steps.find((s) => s.classification === classification) ?? steps[0]!;
  const finishedAt = new Date(deps.now());
  const changed = combinedChange(steps);
  const shouldReport = schedule.reportPolicy === 'always'
    || (schedule.reportPolicy === 'on_change_or_failure'
      && (classification !== 'ok' || changed === null || changed > 0));

  let reportPath: string | null = null;
  if (shouldReport) {
    const stamp = reportStamp(org.timezone, run.fireAt.getTime());
    const reportSteps: ReportStep[] = steps.map((s) => ({
      argv: s.argv, exitCode: s.exitCode, classification: s.classification,
    }));
    const body = renderReport({
      job: schedule.name, scheduleId: schedule.id, runId: run.id, slot: run.slot, stamp,
      timezone: org.timezone, fireAt: run.fireAt, startedAt, finishedAt,
      connection: {
        id: connection.id, clientName: connection.clientName, writeSpace: writeSpace.sourceId,
      },
      scope: command.scope, argv: decisive.argv, exitCode: decisive.exitCode,
      classification, payload: decisive.payload,
      // Every step's output survives: a report that drops the half of the run
      // that actually failed is worse than no report.
      stdout: joinStream('stdout', steps),
      stderr: joinStream('stderr', steps),
      steps: reportSteps,
    });
    try {
      const written = await deps.writeReport({
        sourceId: writeSpace.sourceId, job: schedule.name, stamp, reportBody: body, actor,
      });
      reportPath = written.relPath;
    } catch (e) {
      await alert(schedule, run.id, 'report_write_failed', {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Quiet hours HOLD output; they never drop it. The briefing drain releases it.
  const held = schedule.notifies
    && inQuietHours(org.timezone, finishedAt.getTime(), org.quietHoursStart, org.quietHoursEnd);
  if (held) {
    await db.insert(schema.heldNotifications).values({
      id: randomUUID(), organizationId: schedule.organizationId, scheduleId: schedule.id,
      runId: run.id, scheduleName: schedule.name, reportPath,
      headline: `${schedule.name} — ${classification}`,
    });
  }

  await finishRun(run.id, {
    state: held ? 'held' : classification === 'ok' ? 'succeeded'
      : classification === 'cancelled' ? 'cancelled' : 'failed',
    classification,
    exitCode: decisive.exitCode,
    reportPath,
    // S3c: counts and status only. Never stdout, never argv values.
    summary: { changed, status: summaryStatus(decisive.payload) },
  });

  if (classification !== 'ok' && classification !== 'cancelled') {
    await alert(schedule, run.id, alertKind(command.id, classification), {
      classification, exitCode: decisive.exitCode, status: summaryStatus(decisive.payload),
    });
  }

  return { classification, reportPath };
}

/**
 * The morning briefing: quiet hours hold output, this releases it into one
 * report. It runs no gbrain command, so the Connection buys only where the
 * report lands and who signs it — which is exactly why a schedule whose
 * Connection is gone still refuses here, BEFORE the drain. Draining first would
 * stamp the held rows released with nowhere for the body to go; refusing first
 * keeps them held, so the next briefing picks them up.
 */
async function runBriefing(
  schedule: ScheduleRow,
  run: ClaimedRun['run'],
  deps: ExecuteDeps,
): Promise<{ classification: Classification; reportPath: string | null }> {
  const context = await loadContext(schedule);
  if ('error' in context) {
    await fail(run.id, schedule, 'refused', context.error);
    return { classification: 'refused', reportPath: null };
  }
  const { org, writeSpace, actor } = context;

  const { released, body } = await drainHeldNotifications(
    schedule.organizationId, run.id, deps.now(),
  );

  let reportPath: string | null = null;
  try {
    const written = await deps.writeReport({
      sourceId: writeSpace.sourceId, job: schedule.name,
      stamp: reportStamp(org.timezone, run.fireAt.getTime()), reportBody: body, actor,
    });
    reportPath = written.relPath;
  } catch (e) {
    // Same as any other report write: the drain happened, the operator gets an
    // alert. The released rows keep their own report pointers, so the bodies
    // are still reachable even though the briefing summary is missing.
    await alert(schedule, run.id, 'report_write_failed', {
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // No gbrain ran, so there is no exit code to record: `released` is the whole
  // of what this run did.
  await finishRun(run.id, {
    state: 'succeeded', classification: 'ok', reportPath, summary: { released },
  });

  return { classification: 'ok', reportPath };
}

/** One step's stream verbatim; a multi-step run labels each block with its argv. */
function joinStream(kind: 'stdout' | 'stderr', steps: Step[]): string {
  const multi = steps.length > 1;
  return steps
    .filter((s) => s[kind].trim().length > 0)
    .map((s) => (multi ? `$ ${s.argv.join(' ')}\n${s[kind]}` : s[kind]))
    .join('\n');
}

function summaryStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const s = (payload as { status?: unknown; sync_status?: unknown });
  if (typeof s.status === 'string') return s.status;
  if (typeof s.sync_status === 'string') return s.sync_status;
  return null;
}

function alertKind(commandId: string, classification: Classification): string {
  if (commandId === 'sources-push') {
    if (classification === 'conflict') return 'push_rejected';
    if (classification === 'blocked' || classification === 'refused') return 'push_blocked';
  }
  return `run_${classification}`;
}

type ScheduleContext = { error: string } | {
  org: typeof schema.organizations.$inferSelect;
  connection: typeof schema.connections.$inferSelect;
  writeSpace: typeof schema.spaces.$inferSelect;
  actor: { name: string; email: string };
};

async function loadContext(schedule: ScheduleRow): Promise<ScheduleContext> {
  const db = getDb();
  const [org] = await db.select().from(schema.organizations)
    .where(eq(schema.organizations.id, schedule.organizationId));
  if (!org) return { error: `organization ${schedule.organizationId} not found` };

  if (!schedule.connectionId) {
    return { error: 'schedule has no Connection — it was revoked (honesty rule 3)' };
  }
  const [connection] = await db.select().from(schema.connections)
    .where(eq(schema.connections.id, schedule.connectionId));
  if (!connection) return { error: `connection ${schedule.connectionId} not found` };
  if (connection.state !== 'active') {
    return { error: `connection ${connection.id} is ${connection.state}, not active` };
  }

  const [writeSpace] = await db.select().from(schema.spaces)
    .where(eq(schema.spaces.id, connection.writeSpaceId));
  if (!writeSpace) return { error: `write space ${connection.writeSpaceId} not found` };

  // Commit AS the member (Slice 2). Identity comes from membership -> user,
  // never from a request body.
  const [identity] = await db.select({
    name: schema.users.name, email: schema.users.email,
  })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.id, connection.membershipId));
  if (!identity) return { error: `membership ${connection.membershipId} has no user` };

  return {
    org, connection, writeSpace,
    actor: { name: identity.name ?? identity.email, email: identity.email },
  };
}

async function fail(
  runId: string, schedule: ScheduleRow,
  classification: Classification, message: string,
): Promise<void> {
  await finishRun(runId, { state: 'failed', classification, summary: { error: message } });
  await alert(schedule, runId, `run_${classification}`, { message });
}

async function alert(
  schedule: ScheduleRow,
  runId: string | null, kind: string, detail: Record<string, unknown>,
): Promise<void> {
  await getDb().insert(schema.scheduleAlerts).values({
    id: randomUUID(), organizationId: schedule.organizationId, scheduleId: schedule.id,
    runId, kind, detail,
  });
}
