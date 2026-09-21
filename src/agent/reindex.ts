/**
 * The re-index half of a revert (D10 step 3), extracted from `revert.ts` so the
 * Space file write path can reuse it: `sync` then `embed --stale`, through the
 * NORMAL scheduler command path — the same `SCHEDULER_COMMANDS` entries, the same
 * Connection fence, the same ops RPC argv build. No shell, and never gbrain
 * straight from the control plane (S2).
 *
 * The page-level removals that F15 needs are NOT here: they are specific to a
 * revert, and they run BEFORE this (see `purgeRemovedPages` in `revert.ts`).
 */
import { buildArgv, redactArgv } from '../contracts/argv.ts';
import { OPERATIONS } from '../contracts/registry.ts';
import { SCHEDULER_COMMANDS, fenceParams, validateParams, type SchedulerCommand } from '../scheduler/commands.ts';
import { classifyExit, type Classification } from '../scheduler/execute.ts';

/** How long each re-index step may take. Named rather than inherited from a
 *  client default: a human is sitting behind the request that drives this. */
export const INDEX_TIMEOUT_MS = 600_000;

/**
 * The slice of the ops client `runIndexStep` uses. Narrowed rather than
 * `typeof callOps` so a test can inject a recording fake without satisfying the
 * real client's full opts.
 */
export type CallOps = (
  op: string,
  params: Record<string, string | boolean>,
  opts: { json?: boolean; timeoutMs?: number },
) => Promise<{ exitCode: number; stderr: string; json: unknown }>;

/**
 * One indexing step's receipt: the argv the scheduler path built, what it exited
 * with, and how `classifyExit` read it — L8's vocabulary, not a second one.
 */
export type IndexStep = {
  argv: string[];
  exitCode: number;
  stderr: string;
  classification: Classification;
};

async function runIndexStep(
  command: SchedulerCommand,
  params: Record<string, string | boolean>,
  deps: { callOps: CallOps },
): Promise<IndexStep> {
  const spec = OPERATIONS[command.operation];
  if (!spec) throw new Error(`scheduler command ${command.id} names an unknown operation ${command.operation}`);
  const argv = redactArgv(spec, ['gbrain', ...buildArgv(spec, params, { json: command.json })]);

  try {
    const r = await deps.callOps(command.operation, params, {
      json: command.json, timeoutMs: INDEX_TIMEOUT_MS,
    });
    return {
      argv, exitCode: r.exitCode, stderr: r.stderr,
      classification: classifyExit(command.id, r.exitCode, r.json),
    };
  } catch (e) {
    // The op never produced an exit code: -1 classifies as a plain failure, and
    // the thrown message is the only diagnosis there is (execute.ts's runStep
    // holds the same line).
    return {
      argv, exitCode: -1, stderr: e instanceof Error ? e.message : String(e),
      classification: classifyExit(command.id, -1, null),
    };
  }
}

/**
 * `sync` then `embed --stale` for one source, through the scheduler allowlist.
 *
 * The embed runs ONLY when sync succeeded — the rule `live-sync`'s step 2
 * carries: embedding a half-imported Space commits chunks of a state sync never
 * reached. A failed sync is returned with `embed: null`, so the caller can see
 * the step that failed rather than a fabricated second one.
 */
export async function syncAndEmbed(
  sourceId: string,
  deps: { callOps: CallOps },
): Promise<{ sync: IndexStep; embed: IndexStep | null }> {
  const sync = SCHEDULER_COMMANDS['sync'];
  const embed = SCHEDULER_COMMANDS['embed'];
  if (!sync || !embed) throw new Error('the scheduler allowlist is missing sync or embed');

  const syncStep = await runIndexStep(
    sync, fenceParams(sync, validateParams(sync, {}), sourceId), deps,
  );
  if (syncStep.classification !== 'ok') return { sync: syncStep, embed: null };

  return {
    sync: syncStep,
    embed: await runIndexStep(
      embed, fenceParams(embed, validateParams(embed, { stale: true }), sourceId), deps,
    ),
  };
}
