#!/usr/bin/env bun
/**
 * The runner process. One loop, one job: take an `agent_prompt` claim from the
 * control plane, run the pinned harness on it inside a throwaway workspace, and
 * report the run's receipt back.
 *
 *   claim -> verify the pin -> create workspace -> build argv -> spawn -> stream
 *         -> finish -> destroy workspace -> loop
 *
 * **Its first act is a refusal** (S2). This container holds `RUNNER_TOKEN` and
 * nothing else: no `CONTROL_DATABASE_URL`, no brain DB URL, no `GBRAIN_HOME`, no
 * `OPS_RPC_TOKEN`, no provider key. Without the token it exits non-zero before
 * claiming anything, because compose interpolates `${RUNNER_TOKEN:-}` on both
 * sides precisely so that this guard (and the control plane's `503
 * runner_disabled`) are what refuse. Its second act is another refusal: it will
 * not run if `claude --version` disagrees with the declared pin, because a pin in
 * a YAML file is not evidence the binary moved (D4).
 *
 * SIGTERM sets a drain flag: finish the in-flight run, claim nothing new, exit 0.
 * `destroyWorkspace` runs on every path, including the throw.
 */
import { randomUUID } from 'node:crypto';
import type { AgentRunClaim, AgentRunEvent } from '../agent/types.ts';
import { HARNESS_BIN, verifyHarnessPin } from './pin.ts';
import { ControlFatalError, createControlClient, type ControlClient } from './client.ts';
import { PRODUCT_TOOL_ALLOWLIST } from '../agent/tools.ts';
import {
  buildHarnessArgv, buildHarnessEnv, isErrorFrame, normalizeEvent, numTurnsOf, parseStreamJson,
} from './harness.ts';
import { createWorkspace, destroyWorkspace } from './workspace.ts';

/**
 * D1: `RUNNER_ID = ${HOSTNAME}-${uuid8}`, the same shape as the scheduler's
 * `WORKER_ID`. It is what lands in `schedule_runs.claimed_by`, and it is the
 * identity the heartbeat and the finish must reuse.
 */
export function runnerIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return `${env.HOSTNAME ?? 'runner'}-${randomUUID().slice(0, 8)}`;
}

/**
 * The runner's own first act. Whitespace is not a credential — a token that
 * trims to nothing cannot authenticate, so it is the lane being off rather than
 * a runner waiting for work (the same reading `runnerTokenConfigured` makes on
 * the control-plane side).
 */
export function assertRunnerEnv(env: NodeJS.ProcessEnv = process.env): string {
  const token = (env.RUNNER_TOKEN ?? '').trim();
  if (token === '') {
    throw new Error('RUNNER_TOKEN is unset or empty; the runner refuses to start without it');
  }
  return token;
}

/** The scheduler's cadence, reused: one lease implementation, two consumers (D2). */
const HEARTBEAT_MS = 15_000;
/** Bounded grace between the timeout's SIGTERM and its SIGKILL. */
const KILL_GRACE_MS = 10_000;
const EVENT_BATCH_MAX = 25;
const EVENT_FLUSH_MS = 1_000;
const EVENT_ATTEMPTS = 3;
/** The finish commits, captures heads and revokes a token; three copies of a
 *  180s timeout would outlast the container's own stop grace. */
const FINISH_ATTEMPTS = 2;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

let draining = false;
const drainAbort = new AbortController();

function log(message: string): void {
  console.log(`[runner] ${message}`);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}



/**
 * Read one stream to EOF, handing every decoded chunk to the parser. A single
 * streaming `TextDecoder` matters: a multi-byte character split across two
 * chunks would otherwise corrupt the JSON frame it sits in, and the receipt
 * would be wrong rather than absent.
 */
async function pump(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text !== '') onChunk(text);
  }
  const tail = decoder.decode();
  if (tail !== '') onChunk(tail);
}

/**
 * One claimed run, start to finish. Every exit path — a clean exit, a timeout, a
 * lost lease, a throw inside this function — lands in the same `finally`, which
 * uploads the remaining frames, reports the finish, and destroys the workspace.
 */
async function runClaimedRun(
  claim: AgentRunClaim,
  runnerId: string,
  client: ControlClient,
): Promise<void> {
  const buffer: AgentRunEvent[] = [];
  let seq = 0;
  let errorFrames = 0;
  let numTurns: number | null = null;
  let exitCode = -1; // Task 6's contract: -1 means "no process produced one".
  let stderrText = '';
  let beat: Timer | undefined;
  let deadline: Timer | undefined;
  let graceTimer: Timer | undefined;
  let flushTimer: Timer | undefined;
  let sendQueue: Promise<void> = Promise.resolve();

  const sendBatch = async (
    batch: readonly AgentRunEvent[],
  ): Promise<{ ok: true } | { ok: false; retryable: boolean; detail: string }> => {
    try {
      const result = await client.events(claim.runId, batch);
      if ('ok' in result) return { ok: true };
      // A code the server decided on is terminal for this batch: replaying a
      // frame it calls invalid cannot make it valid, and `run_unknown` means the
      // reclaimer already owns the row.
      return { ok: false, retryable: false, detail: `${result.error}: ${result.detail}` };
    } catch (e) {
      return { ok: false, retryable: true, detail: errorMessage(e) };
    }
  };

  /** Serialized, so a timer tick and a full buffer cannot interleave batches. */
  const upload = (): Promise<void> => {
    sendQueue = sendQueue.then(async () => {
      if (buffer.length === 0) return;
      const batch = buffer.slice();
      for (let attempt = 1; attempt <= EVENT_ATTEMPTS; attempt++) {
        const sent = await sendBatch(batch);
        if (sent.ok) {
          // The buffer may have grown while this batch was in flight.
          buffer.splice(0, batch.length);
          return;
        }
        log(`run ${claim.runId}: ${batch.length} frames not stored (attempt ${attempt}/${EVENT_ATTEMPTS}): ${sent.detail}`);
        if (!sent.retryable) {
          // Never silently: a dropped batch is a hole in the receipt, and the
          // whole point of the receipt is that it can be read (honesty rule 11).
          log(`run ${claim.runId}: ${batch.length} frames DROPPED, the receipt has a gap`);
          buffer.splice(0, batch.length);
          return;
        }
        await Bun.sleep(250 * attempt);
      }
    });
    return sendQueue;
  };

  const push = (event: AgentRunEvent): void => {
    buffer.push(event);
    if (buffer.length >= EVENT_BATCH_MAX) void upload();
  };

  try {
    const workspace = await createWorkspace(claim.runId);

    // D4's runtime cross-check, before a process exists: the claim's pin must
    // equal what the installed binary reports. The control plane checks the
    // version we ADVERTISE at claim time; this checks the binary did not move
    // under us since, which is the failure a YAML pin cannot catch.
    const pin = await verifyHarnessPin(claim.harnessVersion);
    if (pin.matches !== true) {
      log(`run ${claim.runId}: harness_pin_mismatch — claim says ${claim.harnessVersion}, `
        + `the binary reports ${pin.observed ?? 'nothing verifiable'}; refusing to run`);
      push(normalizeEvent({
        type: 'runner_refusal',
        error: 'harness_pin_mismatch',
        expected: claim.harnessVersion,
        observed: pin.observed,
      }, seq++));
      return;
    }

    const argv = buildHarnessArgv(claim);
    const env = buildHarnessEnv(claim);
    log(`run ${claim.runId}: ${claim.model}, ${claim.allowedTools.length} tool(s), `
      + `<=$${claim.budgetUsd}, ${claim.timeoutSeconds}s, workspace ${workspace}`);

    const proc = Bun.spawn([HARNESS_BIN, ...argv], {
      cwd: workspace,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // The lease keeps its own clock: a long model call must not outlive the
    // claim, and a 409 here means someone else owns the row (reclaimed) or
    // `kill_previous` cancelled it. Either way the run stops.
    beat = setInterval(() => {
      void (async () => {
        try {
          const result = await client.heartbeat(claim.runId, runnerId);
          if ('ok' in result) return;
          log(`run ${claim.runId}: lease lost (${result.error}) — ${result.detail}`);
          proc.kill('SIGTERM');
        } catch (e) {
          // A transport blip is not a lost lease; the next tick retries.
          log(`run ${claim.runId}: heartbeat failed: ${errorMessage(e)}`);
        }
      })();
    }, HEARTBEAT_MS);

    // L8: 143 = 128 + SIGTERM is the timeout classification, and that is the
    // CONTROL PLANE's job. The runner reports the exit code it observed and
    // nothing more.
    deadline = setTimeout(() => {
      log(`run ${claim.runId}: ${claim.timeoutSeconds}s timeout — SIGTERM`);
      proc.kill('SIGTERM');
      graceTimer = setTimeout(() => {
        log(`run ${claim.runId}: grace expired — SIGKILL`);
        proc.kill('SIGKILL');
      }, KILL_GRACE_MS);
    }, claim.timeoutSeconds * 1000);

    flushTimer = setInterval(() => void upload(), EVENT_FLUSH_MS);

    let carry = '';
    const stdoutDone = pump(proc.stdout, (chunk) => {
      const parsed = parseStreamJson(chunk, carry);
      carry = parsed.carry;
      for (const line of parsed.badLines) {
        // Reported, never dropped: a line the parser cannot read is a hole in
        // the receipt, and the operator has to be able to see it.
        push(normalizeEvent({ type: 'stream_parse_error', line }, seq++));
      }
      for (const frame of parsed.frames) {
        if (isErrorFrame(frame)) errorFrames++;
        const turns = numTurnsOf(frame);
        if (turns !== null) numTurns = turns;
        push(normalizeEvent(frame, seq++));
      }
    });
    const stderrDone = pump(proc.stderr, (chunk) => {
      stderrText = (stderrText + chunk).slice(-8_000);
    });

    exitCode = await proc.exited;
    await Promise.all([stdoutDone, stderrDone]);
    // Output that ends without a trailing newline still ends with a frame; a
    // frame the end of the stream truncated is reported like any other bad line.
    const tail = parseStreamJson('\n', carry);
    for (const line of tail.badLines) {
      push(normalizeEvent({ type: 'stream_parse_error', line }, seq++));
    }
    for (const frame of tail.frames) {
      if (isErrorFrame(frame)) errorFrames++;
      const turns = numTurnsOf(frame);
      if (turns !== null) numTurns = turns;
      push(normalizeEvent(frame, seq++));
    }
    if (stderrText.trim() !== '') {
      push(normalizeEvent({ type: 'runner_stderr', text: stderrText }, seq++));
    }
    log(`run ${claim.runId}: harness exited ${exitCode}, ${errorFrames} error frame(s)`);
  } catch (e) {
    // A claim that cannot even be turned into a process is still a run that must
    // be answered for: `-1` is the runner's report that no process produced a
    // code, which the control plane classifies `infra_failed` and retries.
    log(`run ${claim.runId}: ${errorMessage(e)}`);
    push(normalizeEvent({ type: 'runner_refusal', error: 'run_not_started', detail: errorMessage(e) }, seq++));
  } finally {
    clearInterval(beat);
    clearInterval(flushTimer);
    clearTimeout(deadline);
    clearTimeout(graceTimer);

    // The workspace is destroyed on EVERY path — including the one where the
    // finish itself throws — so the finish lives inside its own try/finally
    // rather than beside the destroy.
    try {
      await upload();
      await finishRun(client, claim.runId, runnerId, exitCode, errorFrames,
        numTurns === null ? undefined : numTurns);
    } finally {
      // Destroying is hygiene on a tmpfs, and it must never mask the run's own
      // outcome or its finish failure.
      await destroyWorkspace(claim.runId).catch((e: unknown) => {
        log(`run ${claim.runId}: workspace was not destroyed: ${errorMessage(e)}`);
      });
    }
  }
}

/** Report the run's end. A finish the control plane never hears leaves the row
 *  `running` until the reclaimer takes it, so this retries a transport failure. */
async function finishRun(
  client: ControlClient,
  runId: string,
  runnerId: string,
  exitCode: number,
  errorFrames: number,
  numTurns?: number,
): Promise<void> {
  for (let attempt = 1; attempt <= FINISH_ATTEMPTS; attempt++) {
    try {
      const result = await client.finish({
        runId, runnerId, exitCode, errorFrames, ...(numTurns === undefined ? {} : { numTurns }),
      });
      if ('ok' in result) {
        const r = result.result;
        log(`run ${runId}: finished state=${r.state} class=${r.classification} `
          + `failure=${r.failureClass ?? 'none'} cost=${r.costUsd ?? 'unpriced'}`);
        return;
      }
      log(`run ${runId}: finish refused (${result.error}) — ${result.detail}`);
      return;
    } catch (e) {
      if (e instanceof ControlFatalError) throw e;
      log(`run ${runId}: finish failed (attempt ${attempt}/${FINISH_ATTEMPTS}): ${errorMessage(e)}`);
      await Bun.sleep(1_000 * attempt);
    }
  }
}

async function main(): Promise<void> {
  let token: string;
  try {
    token = assertRunnerEnv();
  } catch (e) {
    // One line, naming the variable. Nothing has been claimed; nothing was.
    console.error(`[runner] refusing to start: ${errorMessage(e)}`);
    process.exit(1);
  }

  const runnerId = runnerIdentity();

  // The second refusal: an image whose binary disagrees with its own declared pin
  // is an image nobody can reason about, so it never claims anything.
  const self = await verifyHarnessPin();
  if (self.observed === null || self.matches !== true) {
    console.error(`[runner] refusing to start: the installed harness reports `
      + `${self.observed ?? 'nothing verifiable'}, and this image declares ${self.declared}`);
    process.exit(1);
  }
  const harnessVersion = self.observed;

  const client = createControlClient({ token });

  const drain = (signal: string): void => {
    if (draining) return;
    draining = true;
    log(`${signal}: draining — finishing the in-flight run, claiming nothing new`);
    // A pending long poll is not an in-flight run: cut it short so the drain
    // does not wait out the claim window.
    drainAbort.abort();
  };
  process.on('SIGTERM', () => drain('SIGTERM'));
  process.on('SIGINT', () => drain('SIGINT'));

  log(`${runnerId} up, harness ${harnessVersion}, tools ${PRODUCT_TOOL_ALLOWLIST.length} on the closed list`);
  let backoff = 0;
  while (!draining) {
    try {
      const outcome = await client.claim({ runnerId, harnessVersion, signal: drainAbort.signal });
      if (outcome.status === 'none') {
        // D3: a 204 is not an error. The loop continues immediately.
        backoff = 0;
        continue;
      }
      if (outcome.status === 'refused') {
        log(`claim refused: ${outcome.refusal.error} — ${outcome.refusal.detail}`);
        await Bun.sleep(BACKOFF_MS[Math.min(backoff, BACKOFF_MS.length - 1)]!);
        backoff++;
        continue;
      }
      backoff = 0;
      await runClaimedRun(outcome.claim, runnerId, client);
    } catch (e) {
      if (e instanceof ControlFatalError) {
        console.error(`[runner] refusing to continue: ${errorMessage(e)}`);
        process.exit(1);
      }
      if (draining) break;
      log(`claim failed: ${errorMessage(e)}`);
      await Bun.sleep(BACKOFF_MS[Math.min(backoff, BACKOFF_MS.length - 1)]!);
      backoff++;
    }
  }
  log('stopped');
}

if (import.meta.main) await main();
