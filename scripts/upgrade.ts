#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OPERATIONS } from '../src/contracts/registry.ts';
import { verifyRuntimePin as verifyPinRuntime, writePin, type CallOps } from '../src/contracts/pin.ts';
import { captureCapability, type CapabilityExec, type CapabilitySnapshot } from '../src/contracts/capability.ts';
import { scrubOutput } from '../src/docker/host.ts';
import type { RepoStatus } from '../src/ops/git.ts';
import { appendEvent, openJournal, readJournal, type Journal } from '../src/upgrade/journal.ts';
import { schemaStepJournal, schemaStepParams } from '../src/upgrade/schema-step.ts';
import { verifyManifest } from '../src/upgrade/manifest.ts';
import {
  SNAPSHOT_DATABASES, snapshotVolumes, dockerVolumeDriver, type SnapshotContext,
} from '../src/upgrade/snapshot.ts';
import { QUIESCE_ORDER, composeModel, quiesce, restoreLane, stopServices } from '../src/upgrade/quiesce.ts';
import { hasPlaybook, playbooksFor, type ChecklistItemSpec, type PlaybookSpec } from '../src/upgrade/playbooks/index.ts';
import {
  canTransition, resumeFrom, RESUME_WRITERS_COMMAND, TRANSITIONS, type UpgradeRunState,
} from '../src/upgrade/state.ts';
import { compareDigests, compareDoctor, rollback, stateDigest, type DoctorParity, type StateDigest } from '../src/upgrade/digest.ts';
import type {
  DoctorBaseline, DoctorCheckSummary, SnapshotManifest, UpgradeContext,
} from '../src/upgrade/types.ts';

export type { UpgradeContext };

/** D2: the journal lives here and is the authority while the control plane is down. */
export const UPGRADE_DIR = process.env.UPGRADE_DIR ?? '/srv/upgrades';

/** Images built at the swap. Only gbrain-ops is RECREATED there — see U4 above. */
export const SWAP_SERVICES = ['gbrain-ops', 'gbrain-serve', 'gbrain-worker', 'control-plane'] as const;

/** Tars are uncompressed and pg_dump output is text, so the raw sum is the floor. */
export const SNAPSHOT_SLACK = 1.25;

const VERSION_RE = /^\d+\.\d+\.\d+\.\d+$/;

// Same prefix as scripts/backup.ts:21-25. Project dir stays compose/ so
// ./Caddyfile and ./initdb resolve.
const COMPOSE = [
  'docker', 'compose',
  ...(existsSync('.env') ? ['--env-file', '.env'] as const : []),
  '-f', 'compose/docker-compose.yml',
];

export class UsageError extends Error {}

export type PreflightCode =
  | 'SAME_VERSION' | 'NO_PLAYBOOK' | 'PENDING_CHECKLIST' | 'RUN_IN_FLIGHT' | 'REPO_DRIFT'
  | 'DISK_UNMEASURABLE' | 'INSUFFICIENT_DISK' | 'NO_BASELINE';

export class PreflightRefusal extends Error {
  constructor(readonly code: PreflightCode, message: string) {
    super(message);
    this.name = 'PreflightRefusal';
  }
}

/**
 * The environment for compose children. Bun snapshots the environment at
 * process start (runtime `process.env` edits are invisible to later spawns),
 * and Bun auto-loads `.env`, so this process's GBRAIN_VERSION is the pin from
 * BEFORE the run rewrote it. Every compose call here passes `--env-file .env`,
 * so dropping the var makes `.env` the one source for all of them — including
 * `up`, which otherwise reverts an un-version-tagged service to the old pin.
 */
function childEnvNoPin(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.GBRAIN_VERSION;
  return env;
}

async function sh(argv: string[], timeoutMs = 900_000): Promise<{ exitCode: number; stderr: string }> {
  const p = Bun.spawn(argv, { stdout: 'inherit', stderr: 'pipe', env: childEnvNoPin() });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [stderr, exitCode] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { exitCode, stderr: scrubOutput(stderr) };
}

async function shCapture(
  argv: string[], timeoutMs = 900_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', env: childEnvNoPin() });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { exitCode, stdout: scrubOutput(stdout), stderr: scrubOutput(stderr) };
  } finally {
    clearTimeout(timer);
  }
}

async function feedString(
  argv: string[], input: string, timeoutMs = 900_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: childEnvNoPin() });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    await p.stdin.write(input);
    await p.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { exitCode, stdout, stderr: scrubOutput(stderr) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reach the ops RPC from the host. Production publishes no ops port (S2), so
 * this is scripts/restore.ts:170-182's pattern: a bun program inside the
 * container POSTs to loopback. The file-plane advisory lock is taken by the ops
 * server around the call (S3), which is the only place it can be taken.
 *
 * Only `exitCode` is relayed back. apply-migrations has no --json and its prose
 * is not ours to parse (U3, G3) — keeping the text inside the container means
 * there is nothing here for anyone to start regexing later.
 */
const OPS_RPC_PROGRAM = `
let input = '';
for await (const chunk of process.stdin) input += chunk;
const base = process.env.OPS_RPC_URL ?? 'http://127.0.0.1:3140';
const res = await fetch(base + '/rpc', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPS_RPC_TOKEN },
  body: input,
});
if (!res.ok) { console.error('ops rpc -> ' + res.status); process.exit(1); }
const payload = await res.json();
console.log(JSON.stringify({ exitCode: payload.exitCode }));
`;

export async function opsRpc(
  ctx: UpgradeContext, op: string, params: Record<string, unknown>, timeoutMs = 900_000,
): Promise<{ exitCode: number }> {
  const r = await feedString(
    [...ctx.compose, 'exec', '-T', 'gbrain-ops', 'bun', '-e', OPS_RPC_PROGRAM],
    JSON.stringify({ op, params, timeoutMs }),
    timeoutMs,
  );
  if (r.exitCode !== 0) throw new Error(`ops rpc ${op} relay failed (${r.exitCode}): ${r.stderr}`);
  return JSON.parse(r.stdout.trim()) as { exitCode: number };
}

/**
 * A JSON-returning ops relay for the read paths preflight needs (repo drift,
 * the runtime-pin probe). Same transport as `opsRpc`, but keeps the payload
 * inside our own process instead of dropping it — no gbrain prose is parsed,
 * only JSON fields the registry's contract tests already pin.
 */
async function relayOps(
  ctx: UpgradeContext, path: string, body: unknown, timeoutMs = 300_000,
): Promise<unknown> {
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
    [...ctx.compose, 'exec', '-T', 'gbrain-ops', 'bun', '-e', program],
    JSON.stringify(body), timeoutMs,
  );
  if (r.exitCode !== 0) throw new Error(`ops relay ${path} failed (${r.exitCode}): ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

/**
 * Key NAMES and the env var only (S3c). post-upgrade adds self_upgrade.mode and
 * self_upgrade.mode_prompted to config.json (U4); GBRAIN_SELF_UPGRADE_MODE
 * overrides config (U5), so the kill switch holds — but the run records what
 * changed instead of ignoring it, and fails if the env var itself went missing,
 * which is exactly what v0.50.5.0's .env guardrail quarantine could do (U12).
 */
const SELF_UPGRADE_PROBE_PROGRAM = `
const home = process.env.GBRAIN_HOME ?? '/srv/gbrain-home';
let keys = [];
try {
  const raw = await Bun.file(home + '/.gbrain/config.json').text();
  const flat = (o, p) => Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? flat(v, p + k + '.') : [p + k]);
  keys = flat(JSON.parse(raw), '').sort();
} catch {}
console.log(JSON.stringify({ mode: process.env.GBRAIN_SELF_UPGRADE_MODE ?? '', keys }));
`;

async function probeSelfUpgrade(ctx: UpgradeContext): Promise<{ mode: string; keys: string[] }> {
  const r = await shCapture(
    [...ctx.compose, 'exec', '-T', 'gbrain-ops', 'bun', '-e', SELF_UPGRADE_PROBE_PROGRAM], 60_000,
  );
  if (r.exitCode !== 0) throw new Error(`self-upgrade probe failed (${r.exitCode}): ${r.stderr}`);
  return JSON.parse(r.stdout.trim()) as { mode: string; keys: string[] };
}

export type ParsedArgs =
  | { cmd: 'plan'; to: string }
  | { cmd: 'run'; to: string; yes: boolean }
  | { cmd: 'rollback'; runId: string }
  | { cmd: 'status'; runId: string | null }
  | { cmd: 'resume-writers'; runId: string };

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const cmd = argv[0];
  const to = flag(argv, '--to');
  const runId = flag(argv, '--run');
  const requireVersion = (v: string | null): string => {
    if (!v) throw new UsageError('--to <version> is required');
    // G1: the pin never moves to a moving tag, and the CLI says so itself
    // rather than leaving it to lint:forbidden's `moving-pin` rule.
    if (!VERSION_RE.test(v)) throw new UsageError(`${v} is not a four-part version (e.g. 0.50.5.0)`);
    return v;
  };

  switch (cmd) {
    case 'plan': return { cmd: 'plan', to: requireVersion(to) };
    case 'run': return { cmd: 'run', to: requireVersion(to), yes: argv.includes('--yes') };
    case 'rollback':
      if (!runId) throw new UsageError('rollback requires --run <id>: a rollback addresses a run');
      return { cmd: 'rollback', runId };
    case 'status': return { cmd: 'status', runId };
    case 'resume-writers':
      if (!runId) throw new UsageError('resume-writers requires --run <id>: it finishes a held run');
      return { cmd: 'resume-writers', runId };
    default:
      throw new UsageError(
        'usage: bun run scripts/upgrade.ts <plan|run|rollback|status|resume-writers> ' +
        '[--to <version>] [--run <id>] [--yes]',
      );
  }
}

export async function buildContext(
  args: { to: string; dryRun: boolean }, runId = `run-${randomUUID()}`,
): Promise<UpgradeContext> {
  const fromVersion = process.env.GBRAIN_VERSION ?? '0.50.5.0';
  const upgradeDir = join(UPGRADE_DIR, runId);
  let journal: Journal | null = null;
  if (!args.dryRun) {
    await mkdir(upgradeDir, { recursive: true });
    // BUG 2 (Task 17): the journal module joins `runId` onto the directory it
    // is handed, so it must be handed the ROOT (`UPGRADE_DIR`), not the run
    // directory. Handing it `upgradeDir` produced
    // `UPGRADE_DIR/<runId>/<runId>/journal.ndjson`, while the reconciler reads
    // `UPGRADE_DIR/<runId>/journal.ndjson` (src/upgrade/reconcile.ts:120) — a
    // real run's journal was invisible to reconciliation.
    journal = await openJournal(UPGRADE_DIR, runId);
  }
  return {
    runId, fromVersion, toVersion: args.to, dryRun: args.dryRun,
    upgradeDir, envPath: '.env', compose: [...COMPOSE],
    journal, now: () => new Date(),
  };
}

/**
 * The checklist row preflight refuses on. `prompt`/`why`/`state` are carried
 * through so a caller can name the undecided item; only the first four are used
 * by `preflight`'s message.
 */
export type PendingDecision = {
  id: string; runId: string; version: string; key: string;
  prompt?: string; why?: string; state?: string;
  decidedBy?: string | null; decidedAt?: string | null;
};

/**
 * A run a worker is holding RIGHT NOW — `schedule_runs.state = 'running'`,
 * either lane (an `agent_prompt` run is claimed through the same ledger, so one
 * query covers both). `pending` is deliberately not in this type: it is a
 * materialized future occurrence, and every enabled schedule has those all day.
 */
export type InFlightRun = {
  id: string; scheduleId: string; jobType?: string; state?: string;
  startedAt?: string | null; claimedBy?: string | null;
};

export type PreflightDeps = {
  pendingDecisions(): Promise<PendingDecision[]>;
  inFlightRuns(): Promise<InFlightRun[]>;
  resolvePlaybooks(from: string, to: string): PlaybookSpec[];
  inspectRepos(): Promise<RepoStatus[]>;
  measureSnapshotBytes(): Promise<number>;
  freeBytes(path: string): Promise<number>;
  captureDoctorBaseline(): Promise<DoctorBaseline>;
  pushSources(): Promise<boolean>;
};

export type PreflightReport = {
  fromVersion: string;
  toVersion: string;
  playbooks: PlaybookSpec[];
  snapshotBytes: number;
  requiredBytes: number;
  freeBytes: number;
  repos: RepoStatus[];
  baseline: DoctorBaseline;
  sourcesPushed: boolean;
};

/**
 * Every refusal here happens BEFORE anything is touched, and the order is
 * cheapest-first so that a refusal never leaves a half-captured baseline.
 */
export async function preflight(ctx: UpgradeContext, deps: PreflightDeps): Promise<PreflightReport> {
  if (ctx.toVersion === ctx.fromVersion) {
    throw new PreflightRefusal('SAME_VERSION', `already pinned at ${ctx.fromVersion}`);
  }

  let playbooks: PlaybookSpec[];
  try {
    playbooks = deps.resolvePlaybooks(ctx.fromVersion, ctx.toVersion);
  } catch (e) {
    throw new PreflightRefusal('NO_PLAYBOOK', (e as Error).message);
  }

  const pending = await deps.pendingDecisions();
  if (pending.length > 0) {
    throw new PreflightRefusal(
      'PENDING_CHECKLIST',
      `${pending.length} checklist item(s) from a previous run are still undecided: ` +
      `${pending.map((p) => `${p.version}/${p.key}`).join(', ')}. Decide them in the console first — ` +
      'stacking an upgrade on an unresolved judgement call makes both unattributable.',
    );
  }

  // D13 / Task 14: the check quiesce.ts's own stop-grace doc block claimed Task
  // 11 preflight already made, and did not — PreflightDeps had no in-flight-run
  // dependency at all. It sits BEFORE the repo inspection on purpose: a run that
  // is in flight is writing to a Space as this runs, so inspecting first would
  // report the run's own uncommitted files as REPO_DRIFT and refuse the upgrade
  // with the wrong code for the wrong reason.
  //
  // One query covers both lanes: an agent run is claimed through the same
  // `schedule_runs` ledger (`claimNextRun`'s jobTypes filter), so its row is
  // `running` for as long as its harness is.
  let inFlight: InFlightRun[];
  try {
    inFlight = await deps.inFlightRuns();
  } catch (e) {
    // A check that never ran is not a pass (the DISK_UNMEASURABLE rule): the
    // ledger is exactly where quiesce.ts sends the question of whether it is
    // safe to freeze the brain, so an unreadable ledger refuses.
    throw new PreflightRefusal(
      'RUN_IN_FLIGHT',
      `the run ledger could not be read (${(e as Error).message}); refusing rather than snapshotting ` +
      'a brain a run may be mid-write on',
    );
  }
  if (inFlight.length > 0) {
    throw new PreflightRefusal(
      'RUN_IN_FLIGHT',
      `${inFlight.length} scheduled run(s) are in flight right now: ` +
      `${inFlight.map((r) => `${r.id}${r.jobType ? ` (${r.jobType})` : ''}` +
        ` since ${r.startedAt ?? 'unknown'}`).join(', ')}. ` +
      'A run that is mid-write would be frozen half-written by the snapshot, which is the ' +
      'inconsistency the quiesce drain proof exists to prevent. Wait for it to finish — a dead ' +
      "worker's row is reclaimed to `lease_expired` by the scheduler leader — or cancel it in the " +
      'console first.',
    );
  }

  const repos = await deps.inspectRepos();
  const dirty = repos.filter((r) => r.uncommittedFiles > 0 || r.unpushedCommits > 0 || r.staleLock);
  if (dirty.length > 0) {
    throw new PreflightRefusal(
      'REPO_DRIFT',
      `Space repos have drift the snapshot would freeze: ${dirty.map((r) =>
        `${r.sourceId}(${r.uncommittedFiles} uncommitted, ${r.unpushedCommits} unpushed` +
        `${r.staleLock ? ', STALE LOCK' : ''})`).join(', ')}`,
    );
  }

  const snapshotBytes = await deps.measureSnapshotBytes();
  const requiredBytes = Math.ceil(snapshotBytes * SNAPSHOT_SLACK);
  let free: number;
  try {
    free = await deps.freeBytes(UPGRADE_DIR);
  } catch (e) {
    throw new PreflightRefusal(
      'DISK_UNMEASURABLE',
      `free space at ${UPGRADE_DIR} could not be measured (${(e as Error).message}); ` +
      'refusing rather than assuming room — a snapshot that runs out of disk does so with every ' +
      'writer already stopped',
    );
  }
  if (free < requiredBytes) {
    throw new PreflightRefusal(
      'INSUFFICIENT_DISK',
      `the snapshot needs ~${requiredBytes} bytes at ${UPGRADE_DIR} (measured ${snapshotBytes} ` +
      `plus ${Math.round((SNAPSHOT_SLACK - 1) * 100)}% slack) and only ${free} are free`,
    );
  }

  let baseline: DoctorBaseline;
  try {
    baseline = await deps.captureDoctorBaseline();
  } catch (e) {
    throw new PreflightRefusal(
      'NO_BASELINE',
      `the doctor baseline could not be captured (${(e as Error).message}); without it the exit ` +
      'gate has nothing to compare against and would pass vacuously (D5)',
    );
  }

  // Best effort, exactly like scripts/backup.ts:137-138: the git remotes are
  // the durable copy of a Space's content, but an unreachable remote is not a
  // reason to refuse an upgrade. Reported, never fatal.
  const sourcesPushed = await deps.pushSources().catch(() => false);

  return {
    fromVersion: ctx.fromVersion, toVersion: ctx.toVersion, playbooks,
    snapshotBytes, requiredBytes, freeBytes: free, repos, baseline, sourcesPushed,
  };
}

/** Atomic pin rewrite lives in the pin module so `rollback()` can import it
 *  statically. Re-exported here because this CLI is where it used to live. */
export { writePin } from '../src/contracts/pin.ts';

export type RunDeps = PreflightDeps & {
  snapshot(ctx: UpgradeContext, drain: unknown): Promise<SnapshotManifest>;
  emitOperations(version: string): Promise<void>;
  buildImages(ctx: UpgradeContext, version: string): Promise<void>;
  recreate(ctx: UpgradeContext, services: readonly string[]): Promise<void>;
  resume(ctx: UpgradeContext, services?: readonly string[]): Promise<void>;
  captureDoctorAfter(ctx: UpgradeContext): Promise<DoctorBaseline>;
  rollback(ctx: UpgradeContext, runId: string): Promise<{ ok: boolean }>;
};

export type UpgradeReport = {
  runId: string; fromVersion: string; toVersion: string;
  state: UpgradeRunState; ok: boolean; rolledBack: boolean; notes: string[];
};

/**
 * Doctor parity is scored only after the baseline writers are back, including
 * gbrain-worker. compareDoctor is not filtered: a supervisor that is warn
 * while that worker is up is still a regression. A blocksResume hold stops
 * writers only after a passing gate, so a held-down supervisor is never the
 * thing the gate scores.
 */
export async function resumeBaselineThenGate(input: {
  resumeBaseline: () => Promise<void>;
  captureDoctor: () => Promise<DoctorBaseline>;
  baseline: DoctorBaseline;
  holdWriters: boolean;
  stopHeld: () => Promise<void>;
  recordGate: (parity: DoctorParity) => Promise<void>;
}): Promise<{ parity: DoctorParity; held: boolean }> {
  await input.resumeBaseline();
  const after = await input.captureDoctor();
  const parity = compareDoctor(input.baseline, after);
  await input.recordGate(parity);
  if (parity.regressed.length > 0 || !parity.schemaVersionOk) {
    return { parity, held: false };
  }
  if (input.holdWriters) {
    await input.stopHeld();
    return { parity, held: true };
  }
  return { parity, held: false };
}

/** The supervisor check reads a DB lock the worker takes after start. Wait
 *  only when the baseline scored it ok, so the gate sees that same writer up.
 *  A timeout does not skip the check: doctor still runs and compareDoctor
 *  still scores whatever it finds. */
async function waitForBaselineSupervisor(ctx: UpgradeContext, baseline: DoctorBaseline): Promise<void> {
  if (baseline.checks.find((c) => c.name === 'supervisor')?.status !== 'ok') return;
  for (let i = 0; i < 30; i += 1) {
    const r = await opsRpc(ctx, 'jobs.supervisorStatus', {}, 30_000);
    if (r.exitCode === 0) return;
    await Bun.sleep(2_000);
  }
}

/** A dry run has no journal; a real run must never be handed a context without one. */
function requireJournal(ctx: UpgradeContext): Journal {
  if (!ctx.journal) {
    throw new Error('no journal on this context: only a dry run may omit it, and a dry run never writes');
  }
  return ctx.journal;
}

/**
 * The roadmap's eight steps, in order, each journaled before the next begins
 * (D2). Every transition goes through canTransition, so an illegal one throws
 * here rather than being written to the journal and inherited by the reconciler.
 *
 * Journal shape note: the canonical `appendEvent` (Task 4, src/upgrade/journal.ts)
 * records `{ step, level, message, data }`, not `{ state, note }`. This module
 * puts the run state in `step` and the human note in `message`; `statusOf` reads
 * it back the same way.
 */
export async function runUpgrade(ctx: UpgradeContext, deps: RunDeps): Promise<UpgradeReport> {
  const journal = requireJournal(ctx);
  const notes: string[] = [];
  let state: UpgradeRunState = 'planned';
  const enter = async (to: UpgradeRunState, note: string, data: Record<string, unknown> = {}) => {
    if (!canTransition(state, to)) throw new Error(`illegal upgrade transition ${state} -> ${to}`);
    state = to;
    notes.push(note);
    await appendEvent(journal, { step: to, message: note, data });
  };
  await appendEvent(journal, {
    step: 'planned', message: `${ctx.fromVersion} -> ${ctx.toVersion}`, data: {},
  });

  // 1. Preflight.
  const pre = await preflight(ctx, deps);
  await writeFile(join(ctx.upgradeDir, 'doctor-baseline.json'),
    `${JSON.stringify(pre.baseline, null, 2)}\n`);
  // D2/Task 8 (F7): capture the FROM pin's capability BEFORE the pre-upgrade
  // digest, so digest-before and the snapshot agree about the runtime files the
  // capture itself makes gbrain write. The stack is still up here — the quiesce
  // that opens the try block stops gbrain-serve (D3).
  await captureCapabilityForRun(ctx, ctx.fromVersion, 'capability-from.json');
  const before = await stateDigest(ctx);
  await writeFile(join(ctx.upgradeDir, 'digest-before.json'),
    `${JSON.stringify(before, null, 2)}\n`);
  await enter('preflight_ok', 'preflight passed and the pre-upgrade digest is on disk', {
    playbooks: pre.playbooks.map((p) => p.version),
    requiredBytes: pre.requiredBytes, freeBytes: pre.freeBytes, sourcesPushed: pre.sourcesPushed,
    digestBefore: before.parts.map((p) => `${p.name}:${p.sha256.slice(0, 12)}`),
  });

  try {
    // 2. Quiesce. D3: the order is the atomicity guarantee.
    const quiesceStartedAt = Date.now();
    const drain = await quiesce(ctx);
    await enter('quiesced', 'stack drained to Postgres only', {
      stopped: drain.stopped, drainProof: drain.proof, drainMs: drain.elapsedMs,
    });

    // 3. Snapshot, verified immediately. An unverifiable snapshot aborts here —
    //    before the swap — because after the swap it is the only way back (D4).
    const snapshotStartedAt = Date.now();
    const manifest = await deps.snapshot(ctx, drain);
    const snapshotMs = Date.now() - snapshotStartedAt;
    const verified = await verifyManifest(manifest, ctx.upgradeDir);
    if (!verified.ok) {
      throw new Error(`snapshot failed verification: ${verified.mismatches.join(', ')}`);
    }
    await enter('snapshot_taken', 'four artifacts written and checksum-verified', {
      artifacts: manifest.artifacts.map((a) => `${a.name}:${a.bytes}:${a.sha256.slice(0, 12)}`),
      snapshotMs,
    });
    // The manifest itself, durable on the journal (C7 reads it from the run's
    // own record, not from a file a later run could overwrite).
    await appendEvent(journal, {
      step: 'snapshot', message: 'snapshot manifest recorded',
      data: { manifest, durationMs: snapshotMs },
    });

    // 4. Swap. The old pin is already durable in manifest.fromVersion, so a
    //    death between the rewrite and the journal append still leaves rollback
    //    able to restore it. D8: operations:emit BEFORE the control-plane image
    //    builds — docker/control-plane.Dockerfile:18-19 gates on that file.
    const previousPin = await writePin(ctx.envPath, ctx.toVersion);
    await deps.emitOperations(ctx.toVersion);
    await deps.buildImages(ctx, ctx.toVersion);
    await deps.recreate(ctx, ['gbrain-ops']);
    await enter('swapped', 'pin moved, images built, gbrain-ops recreated at the new tag', {
      previousPin, pin: ctx.toVersion, built: [...SWAP_SERVICES], recreated: ['gbrain-ops'],
    });

    // 5. Schema. Exit codes only (U3). gbrain-ops is the only live gbrain
    //    process, so post-upgrade's lock-free config.json rewrite has nobody to
    //    race (U4) and still runs behind ops' advisory lock (S3).
    //    schemaStepParams skips the Phase F autopilot install (0.60.104.0's
    //    `--yes` alone would authorize one) and schemaStepJournal records the
    //    exit code and nothing else — no migration count is claimed for this
    //    delta, because nothing here read upstream's migration files.
    const migrateExit = (await opsRpc(ctx, 'applyMigrations', schemaStepParams())).exitCode;
    await appendEvent(journal, { step: 'schema', ...schemaStepJournal(migrateExit) });
    if (migrateExit !== 0) {
      // U3: exit codes are 0/1/2 and there is no --json. We record the CODE and
      // never parse the prose (G3). The failure is upstream's, at upstream's
      // migration number, raised by the conditions the fixture created.
      throw new Error(`apply-migrations exited ${migrateExit}`);
    }
    const postExit = (await opsRpc(ctx, 'postUpgrade', {})).exitCode;
    if (postExit !== 0) {
      await appendEvent(journal, {
        step: 'schema', message: `post-upgrade exited ${postExit}`,
        data: { exitCode: postExit, outcome: 'failed', evidence: 'post-upgrade refused to complete' },
      });
      throw new Error(`post-upgrade exited ${postExit}`);
    }

    const guard = await probeSelfUpgrade(ctx);
    if (guard.mode !== 'off') {
      throw new Error(
        `GBRAIN_SELF_UPGRADE_MODE is '${guard.mode}' in gbrain-ops, not 'off'. The env var ` +
        'overrides config (U5), so this is the kill switch itself going missing — the likeliest ' +
        "cause is v0.50.5.0's .env guardrail quarantining GBRAIN_* vars (U12).",
      );
    }
    const addedKeys = guard.keys.filter((k) => !before.configKeys.includes(k));
    await enter('migrated',
      'apply-migrations and post-upgrade both exited 0; no migration count is claimed for this ' +
      'delta (U3/G3: the exit code is the whole record). A non-zero exit or a surprise here is a ' +
      'finding for docs/slice-3.5-findings.md, not something to wave through.',
      { applyExit: 0, postExit: 0, selfUpgradeMode: guard.mode, configKeysAdded: addedKeys });

    // 6. Playbooks. Deterministic steps run; checklist items are OPENED as
    //    awaiting_admin_decision. The control plane is down, so both are
    //    journaled for the reconciler rather than written to the DB (D2).
    const ledger: Record<string, unknown>[] = [];
    const checklist: Array<ChecklistItemSpec & { version: string; state: 'pending' }> = [];
    for (const spec of pre.playbooks) {
      if (!hasPlaybook(spec)) {
        ledger.push({
          version: spec.version, state: 'applied',
          notes: `upstream ships no playbook for this version — ${spec.evidence}`,
        });
        continue;
      }
      for (const step of spec.steps) await step.run(ctx);
      for (const item of spec.checklist) {
        checklist.push({ version: spec.version, ...item, state: 'pending' });
      }
      ledger.push({
        version: spec.version,
        state: spec.checklist.length > 0 ? 'awaiting_admin_decision' : 'applied',
        notes:
          `applied ${spec.steps.length} deterministic step(s) ` +
          `[${spec.steps.map((s) => s.id).join(', ')}] hand-translated from ` +
          `${spec.upstreamSkill.path}@${spec.upstreamSkill.sha256.slice(0, 12)}; ` +
          `opened ${spec.checklist.length} checklist item(s)`,
      });
    }
    await enter('playbooks_applied', `${ledger.length} version(s) recorded`, { ledger, checklist });
    const holdWriters = checklist.some((item) => item.blocksResume === true);

    // 7. Bring the baseline writers back, score doctor parity while they are
    //    up, and only then hold. A stopped supervisor must not be scored as a
    //    regression. compareDoctor is not filtered.
    const scored = await resumeBaselineThenGate({
      resumeBaseline: async () => {
        // gbrain-ops is already the new image (recreated at the swap).
        await deps.recreate(ctx, ['gbrain-serve', 'gbrain-worker', 'control-plane']);
        await deps.resume(ctx);
        // Serve is up for this capture. resumeWriters still recaptures after
        // a hold, because the hold that follows a passing gate stops serve.
        await captureCapabilityForRun(ctx, ctx.toVersion, 'capability-to.json', {
          waitForServe: true,
        });
        await waitForBaselineSupervisor(ctx, pre.baseline);
      },
      captureDoctor: () => deps.captureDoctorAfter(ctx),
      baseline: pre.baseline,
      holdWriters,
      stopHeld: async () => { await stopServices(ctx, HELD_WRITER_SERVICES); },
      recordGate: async (parity) => {
        await appendEvent(journal, {
          step: 'gate', message: 'doctor parity computed per check (D5)',
          data: { parity },
        });
      },
    });
    const parity = scored.parity;
    if (parity.regressed.length > 0 || !parity.schemaVersionOk) {
      throw new Error(
        `doctor parity gate failed: regressed=[${parity.regressed.map((c) => c.name).join(', ')}] ` +
        `schemaVersionOk=${parity.schemaVersionOk}`,
      );
    }
    const gateData = {
      regressed: [], resolved: parity.resolved.map((c) => c.name),
      newChecks: parity.newChecks.map((c) => c.name),
      status: parity.status, healthScore: parity.healthScore,
    };
    if (scored.held) {
      await enter('gated_ok', 'doctor parity holds per check (D5); writers held', {
        ...gateData, writers: 'held', reason: 'blocks_resume',
      });
      const command = `${RESUME_WRITERS_COMMAND} ${ctx.runId}`;
      console.log(command);
      notes.push(command);
      return {
        runId: ctx.runId, fromVersion: ctx.fromVersion, toVersion: ctx.toVersion,
        state, ok: true, rolledBack: false, notes,
      };
    }

    await enter('gated_ok', 'doctor parity holds per check (D5)', gateData);

    await enter('completed', `upgraded ${ctx.fromVersion} -> ${ctx.toVersion}`, {});
    await appendEvent(journal, {
      step: 'run_completed', message: 'run completed',
      // Total downtime: first service stopped → writers back and the gate done.
      data: { downtimeMs: Date.now() - quiesceStartedAt },
    });
    return {
      runId: ctx.runId, fromVersion: ctx.fromVersion, toVersion: ctx.toVersion,
      state, ok: true, rolledBack: false, notes,
    };
  } catch (error) {
    const message = scrubOutput((error as Error).message);
    // 8. Post-swap failure has exactly one destination (Task 10).
    if (!canTransition(state, 'rolling_back')) {
      await appendEvent(journal, { step: 'failed', message, data: {} });
      return {
        runId: ctx.runId, fromVersion: ctx.fromVersion, toVersion: ctx.toVersion,
        state: 'failed', ok: false, rolledBack: false, notes: [...notes, message],
      };
    }
    await enter('rolling_back', message, {});
    const result = await deps.rollback(ctx, ctx.runId);
    await appendEvent(journal, {
      step: result.ok ? 'rolled_back' : 'rollback_failed', message, data: {},
    });
    return {
      runId: ctx.runId, fromVersion: ctx.fromVersion, toVersion: ctx.toVersion,
      state: result.ok ? 'rolled_back' : 'rollback_failed',
      ok: false, rolledBack: result.ok, notes: [...notes, message],
    };
  }
}

/** Dry run. Prints what would happen and changes nothing — no journal, no files. */
export async function planUpgrade(ctx: UpgradeContext, deps: PreflightDeps) {
  const pre = await preflight(ctx, deps);
  return {
    from: pre.fromVersion, to: pre.toVersion,
    playbooks: pre.playbooks.map((p) => hasPlaybook(p)
      ? { version: p.version, steps: p.steps.map((s) => s.id), checklist: p.checklist.map((c) => c.key),
          upstreamSkill: p.upstreamSkill.path }
      : { version: p.version, noPlaybookRequired: true, evidence: p.evidence }),
    snapshot: {
      artifacts: [...dockerVolumeDriver.describe()],
      measuredBytes: pre.snapshotBytes, requiredBytes: pre.requiredBytes, freeBytes: pre.freeBytes,
    },
    repos: pre.repos.map((r) => r.sourceId),
    baseline: { status: pre.baseline.status, checks: pre.baseline.checks.length },
    sourcesPushed: pre.sourcesPushed,
    wouldSwap: [...SWAP_SERVICES],
  };
}

/** Read run state off disk. Works with the control plane down, by design (D2). */
export async function statusOf(runId: string | null) {
  const ids = runId
    ? [runId]
    : (await readdir(UPGRADE_DIR, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isDirectory()).map((e) => e.name);
  const out = [];
  for (const id of ids) {
    const events = await readJournal(UPGRADE_DIR, id).catch(() => []);
    out.push({
      runId: id, events: events.length,
      decision: resumeFrom(events.map((e) => {
        const record: { seq: number; state: string; writers?: 'held' } = { seq: e.seq, state: e.step };
        if (e.step === 'gated_ok' && recordData(e.data)?.writers === 'held') record.writers = 'held';
        return record;
      })),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// defaultDeps: the production wiring. This is the only code that touches Docker
// (D1/S2); it stays argv-array-only and shell-string-free.
// ---------------------------------------------------------------------------

async function pendingDecisions(ctx: UpgradeContext): Promise<PendingDecision[]> {
  const sql =
    "select coalesce(json_agg(json_build_object('id', id, 'runId', run_id, " +
    "'version', gbrain_version, 'key', item_key, 'prompt', prompt, 'why', why, 'state', state)), '[]') " +
    "from upgrade_checklist_items where state = 'pending'";
  const r = await shCapture(
    [...ctx.compose, 'exec', '-T', 'postgres', 'psql', '-U', 'gbrain', '-d', 'control', '-tAc', sql],
    30_000,
  );
  if (r.exitCode !== 0) throw new Error(`pending checklist query failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim() || '[]') as PendingDecision[];
}

/** D13/Task 14: the rows a worker is holding, either lane. Exported because the
 *  contract suite runs THIS query against the real control schema — a column
 *  that does not exist is the L9/F3 class of defect, and a stub cannot catch
 *  it. */
export const IN_FLIGHT_RUNS_SQL =
  'select coalesce(json_agg(json_build_object(' +
  "'id', r.id, 'scheduleId', r.schedule_id, 'jobType', s.job_type, 'state', r.state, " +
  "'startedAt', r.started_at, 'claimedBy', r.claimed_by) order by r.started_at), '[]') " +
  'from schedule_runs r left join schedules s on s.id = r.schedule_id ' +
  "where r.state = 'running'";

async function inFlightRuns(ctx: UpgradeContext): Promise<InFlightRun[]> {
  const r = await shCapture(
    [...ctx.compose, 'exec', '-T', 'postgres', 'psql', '-U', 'gbrain', '-d', 'control', '-tAc',
      IN_FLIGHT_RUNS_SQL],
    30_000,
  );
  if (r.exitCode !== 0) throw new Error(`in-flight run query failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim() || '[]') as InFlightRun[];
}

async function inspectReposFromOps(ctx: UpgradeContext): Promise<RepoStatus[]> {
  const payload = await relayOps(ctx, '/git/inspect', {}, 30_000) as { repos?: RepoStatus[] };
  return Array.isArray(payload.repos) ? payload.repos : [];
}

async function measureSnapshotBytes(ctx: UpgradeContext): Promise<number> {
  const sizeSql = "select (pg_database_size('gbrain') + pg_database_size('control'))::bigint";
  const db = await shCapture(
    [...ctx.compose, 'exec', '-T', 'postgres', 'psql', '-U', 'gbrain', '-d', 'control', '-tAc', sizeSql],
    60_000,
  );
  if (db.exitCode !== 0) throw new Error(`snapshot size probe (databases) failed: ${db.stderr}`);
  let total = Number(db.stdout.trim() || '0');
  for (const volume of snapshotVolumes()) {
    // argv array, no shell: a throwaway busybox reports the volume's raw bytes.
    const r = await shCapture(
      ['docker', 'run', '--rm', '-v', `${volume}:/src:ro`, 'busybox', 'du', '-sb', '/src'],
      120_000,
    );
    if (r.exitCode !== 0) throw new Error(`snapshot size probe for ${volume} failed: ${r.stderr}`);
    total += Number(r.stdout.trim().split(/\s+/)[0] ?? '0');
  }
  return total;
}

async function freeBytesAt(path: string): Promise<number> {
  const s = await statfs(path);
  return Number(s.bavail) * Number(s.bsize);
}

function parseDoctorJson(stdout: string): {
  status: string; healthScore: number; checks: DoctorCheckSummary[];
} {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('doctor --json produced no JSON object');
  const parsed = JSON.parse(stdout.slice(start)) as {
    status?: string; health_score?: number; healthScore?: number;
    checks?: Array<{ name?: string; status?: string; category?: string }>;
  };
  return {
    status: parsed.status ?? 'unknown',
    healthScore: parsed.health_score ?? parsed.healthScore ?? 0,
    checks: (parsed.checks ?? []).map((c) => ({
      name: String(c.name ?? ''),
      status: (c.status ?? 'warn') as DoctorCheckSummary['status'],
      ...(c.category ? { category: c.category } : {}),
    })),
  };
}

async function captureDoctor(ctx: UpgradeContext): Promise<DoctorBaseline> {
  const r = await shCapture(
    [...ctx.compose, 'exec', '-T', 'gbrain-ops', 'gbrain', ...OPERATIONS.doctor!.argv, '--json'],
    300_000,
  );
  if (r.exitCode !== 0) throw new Error(`doctor exited ${r.exitCode}: ${r.stderr}`);
  const parsed = parseDoctorJson(r.stdout);
  return { capturedAt: new Date().toISOString(), ...parsed };
}

/** The main stack's `gbrain serve`, reachable from gbrain-ops on brain-net. */
const CAPABILITY_SERVE_URL = process.env.CAPABILITY_SERVE_URL ?? 'http://gbrain-serve:3131';

/**
 * D2/Task 8: capture one pin's capability into the RUN DIRECTORY as data. The
 * host CLI is the only component that can reach a per-pin `gbrain serve` and
 * the pinned binary (D1), and it holds no control-DB connection (D2), so it
 * writes the file + journals a `capability` event; `reconcileJournals` imports
 * the file into `capability_snapshots` when the control plane returns. Reuses
 * Task 8/10's `captureCapability` through an injected exec — there is no second
 * capturer. Fixes F7: `recordCapabilitySnapshot` previously had no product
 * caller, so the table was empty on a real deployment and the drift route 400'd.
 */
async function captureCapabilityForRun(
  ctx: UpgradeContext, version: string, file: string,
  opts: { waitForServe?: boolean; exec?: CapabilityExec } = {},
): Promise<CapabilitySnapshot> {
  const exec: CapabilityExec = opts.exec ?? ((service, argv) =>
    shCapture([...ctx.compose, 'exec', '-T', service, ...argv], 300_000));
  let snap = await captureCapability({ serveBaseUrl: CAPABILITY_SERVE_URL, exec });
  // gbrain-serve may still be settling after a resume; retry so the snapshot
  // carries a real well-known reply rather than a null one. A hold leaves
  // serve down on purpose, so waiting here would only burn the settle budget.
  if (opts.waitForServe !== false) {
    for (let i = 0; i < 30 && snap.wellKnown === null; i += 1) {
      await Bun.sleep(2_000);
      snap = await captureCapability({ serveBaseUrl: CAPABILITY_SERVE_URL, exec });
    }
  }
  await writeFile(join(ctx.upgradeDir, file), `${JSON.stringify(snap, null, 2)}\n`);
  await appendEvent(requireJournal(ctx), {
    step: 'capability', message: `capability captured for ${version}`,
    data: { version, file },
  });
  return snap;
}

async function pushSourcesViaOps(ctx: UpgradeContext): Promise<boolean> {
  const r = await shCapture(
    [...ctx.compose, 'exec', '-T', 'gbrain-ops', 'gbrain', 'sources', 'push', '--all'], 600_000,
  );
  return r.exitCode === 0;
}

async function emitOperations(version: string): Promise<void> {
  const p = Bun.spawn(['bun', 'run', 'operations:emit'], {
    env: { ...process.env, GBRAIN_VERSION: version }, stdout: 'inherit', stderr: 'inherit',
  });
  const code = await p.exited;
  if (code !== 0) throw new Error(`operations:emit exited ${code}`);
}

/** The build overlay (D2). The production file has no `build:` stanzas. */
const BUILD_OVERLAY = 'compose/docker-compose.build.yml';

/** Production compose's image reference, resolved the way compose resolves it. */
function registryRef(name: string, tag: string): string {
  const registry = process.env.IMAGE_REGISTRY ?? 'ghcr.io';
  const namespace = process.env.IMAGE_NAMESPACE ?? 'molioros';
  return `${registry}/${namespace}/${name}:${tag}`;
}

/** `compose/docker-compose.yml:108`'s APP_VERSION fallback chain, verbatim. */
function controlPlaneTag(): string {
  return process.env.APP_VERSION
    ?? process.env.MOBRAIN_VERSION
    ?? process.env.BRAINSTAND_VERSION
    ?? 'dev';
}

async function imagePresent(ref: string): Promise<boolean> {
  return (await shCapture(['docker', 'image', 'inspect', ref], 60_000)).exitCode === 0;
}

/**
 * F25: `buildImages` used to run `docker compose -f compose/docker-compose.yml
 * build …` against a file Task 5 stripped of every `build:` stanza, so it
 * printed "No services to build" and exited 0. A pin move then could not
 * produce the target `gbrain-base`, and a rollback landed on an image that did
 * not exist. This restores the ability to build, honestly:
 *
 *   1. The published image is the production path: pull the target pin.
 *   2. A pin the registry does not carry (every rollback, and any pin a
 *      deployment publishes without) is built with the SAME recipe
 *      `scripts/publish-images.sh:25` uses, tagged at the exact reference
 *      production compose will run.
 *   3. The un-pin-versioned `control-plane` image is rebuilt at `version`
 *      through the build overlay (`docker/control-plane.Dockerfile:7` resolves
 *      its base from the local daemon under the bare `mobrain/gbrain-base`
 *      name, so that mirror is created first).
 *   4. It VERIFIES the target images exist and throws otherwise — a silent
 *      no-op is the bug, not a pass.
 */
async function buildImages(ctx: UpgradeContext, version: string): Promise<void> {
  // The version is passed EXPLICITLY as a build arg. Relying on the ambient
  // GBRAIN_VERSION (process env vs .env precedence) is how a rollback rebuilt
  // the image at the pin the swap had just left behind, leaving the running
  // binary at the new version while `.env` claimed the old one.
  const baseRef = registryRef('gbrain-base', version);
  const controlPlaneRef = registryRef('control-plane', controlPlaneTag());

  if (!(await imagePresent(baseRef))) {
    // Production path first. The Task 5 publish ships only the current pin, so
    // a rollback's pin is normally a registry 404 by design — the build below
    // is the product's registry-less fallback (D2), not an error path.
    const pulled = await sh(['docker', 'pull', baseRef], 1_800_000);
    if (pulled.exitCode !== 0) {
      const built = await sh([
        'docker', 'build', '-f', 'docker/gbrain-base.Dockerfile',
        '--build-arg', `GBRAIN_VERSION=${version}`, '-t', baseRef, '.',
      ], 3_600_000);
      if (built.exitCode !== 0) {
        throw new Error(`gbrain-base build at ${version} failed (${built.exitCode}): ${built.stderr}`);
      }
    }
  }

  if (!(await imagePresent(baseRef))) {
    throw new Error(
      `buildImages produced no ${baseRef}: refusing to report a silent no-op success (F25)`,
    );
  }

  // `docker/control-plane.Dockerfile:7` is `FROM mobrain/gbrain-base:<pin>` —
  // the bare name, not the registry-qualified production reference — so the
  // overlay build resolves it from the local daemon. Mirror the freshly ensured
  // base under exactly that name; it is the same layer set, not a second image.
  const bareBase = `mobrain/gbrain-base:${version}`;
  if (!(await imagePresent(bareBase))) {
    const tag = await sh(['docker', 'tag', baseRef, bareBase], 120_000);
    if (tag.exitCode !== 0) {
      throw new Error(`could not mirror ${baseRef} as ${bareBase}: ${tag.stderr}`);
    }
  }

  const r = await sh(
    [
      ...ctx.compose, '-f', BUILD_OVERLAY, 'build',
      '--build-arg', `GBRAIN_VERSION=${version}`, 'control-plane', 'scheduler',
    ],
    3_600_000,
  );
  if (r.exitCode !== 0) throw new Error(`image build failed (${r.exitCode}): ${r.stderr}`);

  // Verifying the references production compose will actually run is the whole
  // point (F25): a command that exits 0 without those images is the defect.
  const missing: string[] = [];
  for (const ref of [baseRef, controlPlaneRef]) {
    if (!(await imagePresent(ref))) missing.push(ref);
  }
  if (missing.length > 0) {
    throw new Error(`buildImages produced no image for: ${missing.join(', ')} (F25)`);
  }
}

async function defaultRecreate(ctx: UpgradeContext, services: readonly string[]): Promise<void> {
  const r = await sh([...ctx.compose, 'up', '-d', '--force-recreate', '--wait', ...services], 1_800_000);
  if (r.exitCode !== 0) throw new Error(`recreate of [${services.join(', ')}] failed (${r.exitCode}): ${r.stderr}`);
}

/**
 * Bring services back with the CURRENT `.env` pin. `quiesce.ts`'s `resume()`
 * spawns compose from Bun's startup environment snapshot, which still holds the
 * pin from before `writePin()` moved `.env`; its `up -d --no-deps` would then
 * recreate gbrain-serve/worker/control-plane at the OLD pin and silently undo
 * the swap (C8's cross-check catches exactly that). This re-issues the same
 * `up -d --no-deps` through `sh`, whose children carry no stale GBRAIN_VERSION.
 *
 * The lane it walks is `restoreLane`'s, the same one `quiesce.ts` uses: the
 * ACTIVE profile model, so a service the operator never enabled (`agent-runner`
 * is behind the `runner` profile, D12) is not started by an upgrade. Only the
 * spawn path differs here, and that difference is the pin.
 */
async function resumeAtCurrentPin(
  ctx: UpgradeContext, services: readonly string[] = QUIESCE_ORDER,
): Promise<void> {
  const order = restoreLane(await composeModel(ctx.compose), services);
  for (const svc of order) {
    const r = await sh([...ctx.compose, 'up', '-d', '--no-deps', svc], 120_000);
    if (r.exitCode !== 0) throw new Error(`resume: starting ${svc} failed: ${r.stderr}`);
  }
}

async function snapshotWithDrain(ctx: UpgradeContext, drain: unknown): Promise<SnapshotManifest> {
  const snapCtx: SnapshotContext = {
    runId: ctx.runId, volumes: snapshotVolumes(), databases: SNAPSHOT_DATABASES,
    outDir: ctx.upgradeDir, compose: ctx.compose,
  };
  const manifest = await dockerVolumeDriver.take(snapCtx);
  const evidence = (drain ?? {}) as { stopped?: string[]; proof?: unknown };
  return {
    ...manifest,
    // The driver reads process.env.GBRAIN_VERSION for this; after the pin is
    // stripped from the environment (buildContext) that default is wrong for
    // any start other than 0.50.0.0, so the context's own start pin wins.
    fromVersion: ctx.fromVersion,
    // The driver records the empty placeholder (Task 4); the real quiesce
    // evidence is merged here, where it exists.
    quiesce: { stoppedServices: evidence.stopped ?? [], drainProofs: { supervisor: evidence.proof } },
  };
}

async function defaultDeps(ctx: UpgradeContext): Promise<RunDeps> {
  const callOps: CallOps = async <T>(
    op: string,
    params: Record<string, unknown> = {},
    opts: { json?: boolean; dryRun?: boolean; timeoutMs?: number } = {},
  ) => {
    const payload = await relayOps(ctx, '/rpc', {
      op, params, json: opts.json, timeoutMs: opts.timeoutMs,
    }) as { exitCode?: number; json?: T | null };
    return { ok: true, exitCode: payload.exitCode ?? 0, json: payload.json ?? null };
  };
  const verifyPin = async (_ctx: UpgradeContext, _version: string): Promise<boolean> => {
    try { return (await verifyPinRuntime(callOps)).matches === true; } catch { return false; }
  };
  return {
    pendingDecisions: () => pendingDecisions(ctx),
    inFlightRuns: () => inFlightRuns(ctx),
    resolvePlaybooks: (from, to) => playbooksFor(from, to),
    inspectRepos: () => inspectReposFromOps(ctx),
    measureSnapshotBytes: () => measureSnapshotBytes(ctx),
    freeBytes: (path) => freeBytesAt(path),
    captureDoctorBaseline: () => captureDoctor(ctx),
    pushSources: () => pushSourcesViaOps(ctx),
    snapshot: (c, drain) => snapshotWithDrain(c, drain),
    emitOperations: (version) => emitOperations(version),
    buildImages: (c, version) => buildImages(c, version),
    recreate: (c, services) => defaultRecreate(c, services),
    resume: (c, services) => resumeAtCurrentPin(c, services),
    captureDoctorAfter: (c) => captureDoctor(c),
    rollback: async (c, id) => {
      const r = await rollback(c, id, {
        buildImages: (cc, version) => buildImages(cc, version),
        recreate: (cc, services) => defaultRecreate(cc, services),
        resume: (cc) => resumeAtCurrentPin(cc),
        verifyRuntimePin: verifyPin,
      });
      return { ok: r.ok };
    },
  };
}

/** Writers a blocksResume hold leaves down. Order is QUIESCE_ORDER; the
 *  resume dependency starts them in reverse (restoreLane). */
export const HELD_WRITER_SERVICES = [
  'agent-runner', 'scheduler', 'gbrain-worker', 'gbrain-serve',
] as const;

export type ResumeWritersDeps = {
  /**
   * Journal root handed to readJournal and openJournal. The parameter is not
   * the run directory: joining the run id onto the run directory nests the
   * journal one level too deep for the reconciler.
   */
  journalRoot?: string;
  /** Injected by the unit test so it does not start Docker. */
  resume?: (services: readonly string[]) => Promise<void>;
  /**
   * Replaces compose exec for the post-resume capability recapture. The unit
   * test injects it so the settle loop and the new journal event run without
   * Docker. Absent on a host call means the real exec.
   */
  captureExec?: CapabilityExec;
  /** Ops RPC for a declined item's declineOp. No shell string. */
  applyOptOut?: (op: string, params: Record<string, string>) => Promise<void>;
  /**
   * Control-DB overlay. The host CLI passes this because acks land in
   * upgrade_checklist_items, not in the journal. A caller that omits it
   * (the unit test) reads item state from the journal alone.
   */
  decisions?: (runId: string) => Promise<ReadonlyArray<{ key: string; state: string }>>;
};

export type ResumeWritersReport = {
  runId: string;
  state: 'completed';
  resumed: readonly string[];
  alreadyCompleted: boolean;
  optOutsApplied: string[];
};

type BlocksResumeItem = {
  key: string;
  state: 'pending' | 'acknowledged' | 'declined';
  declineOp?: { op: string; params: Record<string, string> };
};

function recordData(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

function parseItemState(raw: unknown): BlocksResumeItem['state'] | null {
  if (raw === 'pending' || raw === 'acknowledged' || raw === 'declined') return raw;
  return null;
}

function parseDeclineOp(raw: unknown): BlocksResumeItem['declineOp'] | undefined {
  const rec = recordData(raw);
  if (!rec || typeof rec.op !== 'string' || rec.op === '') return undefined;
  const params = recordData(rec.params);
  if (!params) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== 'string') return undefined;
    out[k] = v;
  }
  return { op: rec.op, params: out };
}

function blocksResumeItems(events: ReadonlyArray<{ data?: unknown }>): Map<string, BlocksResumeItem> {
  const byKey = new Map<string, BlocksResumeItem>();
  for (const event of events) {
    const list = recordData(event.data)?.checklist;
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const rec = recordData(raw);
      if (!rec || rec.blocksResume !== true || typeof rec.key !== 'string' || rec.key === '') continue;
      const declineOp = parseDeclineOp(rec.declineOp);
      byKey.set(rec.key, {
        key: rec.key,
        state: parseItemState(rec.state) ?? 'pending',
        ...(declineOp ? { declineOp } : {}),
      });
    }
  }
  return byKey;
}

function appliedOptOutKeys(events: ReadonlyArray<{ step: string; data?: unknown }>): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.step !== 'checklist_opt_out') continue;
    const key = recordData(event.data)?.key;
    if (typeof key === 'string' && key !== '') keys.add(key);
  }
  return keys;
}

function heldTargetVersion(events: ReadonlyArray<{ step: string; data?: unknown }>): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const data = recordData(events[i]!.data);
    if (events[i]!.step === 'capability' && data?.file === 'capability-to.json' && typeof data.version === 'string') {
      return data.version;
    }
  }
  return process.env.GBRAIN_VERSION ?? '0.50.5.0';
}

/** Settle-loop recapture. Writes capability-to.json, then appends a new capability seq. */
async function recaptureHeldCapability(
  runId: string, journalRoot: string, version: string, exec?: CapabilityExec,
): Promise<void> {
  const ctx: UpgradeContext = {
    ...hostContext(runId),
    upgradeDir: join(journalRoot, runId),
    journal: await openJournal(journalRoot, runId),
  };
  await captureCapabilityForRun(ctx, version, 'capability-to.json', exec ? { exec } : {});
}

function hostContext(runId: string): UpgradeContext {
  return {
    runId,
    fromVersion: process.env.GBRAIN_VERSION ?? '0.50.5.0',
    toVersion: process.env.GBRAIN_VERSION ?? '0.50.5.0',
    dryRun: false,
    upgradeDir: join(UPGRADE_DIR, runId),
    envPath: '.env',
    compose: [...COMPOSE],
    journal: null,
    now: () => new Date(),
  };
}

/** Ack state for one run. runId is an argv field, never interpolated into a shell.
 *
 *  `:'run_id'` is psql metasyntax. `psql -c` sends the string to the server
 *  without interpolating it (measured on psql 16.15: syntax error at `:`),
 *  so the query is fed on stdin, where that substitution runs. */
async function checklistStates(runId: string): Promise<Array<{ key: string; state: string }>> {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error(`refusing checklist query for run id '${runId}'`);
  }
  const r = await feedString([
    ...COMPOSE, 'exec', '-T', 'postgres', 'psql', '-U', 'gbrain', '-d', 'control',
    '-v', 'ON_ERROR_STOP=1', '-v', `run_id=${runId}`, '-tA',
  ], "select coalesce(json_agg(json_build_object('key', item_key, 'state', state)), '[]') " +
    "from upgrade_checklist_items where run_id = :'run_id';\n", 30_000);
  if (r.exitCode !== 0) throw new Error(`checklist state query failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim() || '[]') as Array<{ key: string; state: string }>;
}

async function applyDeclineOptOut(
  runId: string, op: string, params: Record<string, string>,
): Promise<void> {
  const r = await opsRpc(hostContext(runId), op, params);
  if (r.exitCode !== 0) throw new Error(`decline opt-out ${op} exited ${r.exitCode}`);
}

/**
 * Finish a held gate. Does not rebuild images and does not move the pin.
 * Refuses while any journaled blocksResume item is pending, or declined
 * without an opt-out already applied. A declined item with declineOp has that
 * op applied through ops RPC, then the four held writers resume and the run
 * enters completed.
 */
export async function resumeWriters(
  runId: string, deps: ResumeWritersDeps = {},
): Promise<ResumeWritersReport> {
  const journalRoot = deps.journalRoot ?? UPGRADE_DIR;
  const events = (await readJournal(journalRoot, runId)).slice().sort((a, b) => a.seq - b.seq);
  if (events.length === 0) {
    throw new Error(`no journal for run ${runId}: refusing to resume writers without a recorded hold`);
  }
  const decision = resumeFrom(events.filter((e) => e.step in TRANSITIONS).map((e) => ({
    seq: e.seq,
    state: e.step,
    ...(e.step === 'gated_ok' && recordData(e.data)?.writers === 'held' ? { writers: 'held' as const } : {}),
  })));
  if (decision.kind === 'terminal' && decision.from === 'completed') {
    return { runId, state: 'completed', resumed: [], alreadyCompleted: true, optOutsApplied: [] };
  }
  if (decision.kind !== 'hold-writers') {
    throw new Error(
      `refusing to resume writers for ${runId}: the journal is not gated_ok with writers held`,
    );
  }

  const items = blocksResumeItems(events);
  if (deps.decisions) {
    for (const row of await deps.decisions(runId)) {
      const item = items.get(row.key);
      const state = parseItemState(row.state);
      if (item && state) item.state = state;
    }
  }
  const applied = appliedOptOutKeys(events);
  const optOutsApplied: string[] = [];
  const applyOptOut = deps.applyOptOut ?? ((op, params) => applyDeclineOptOut(runId, op, params));
  for (const item of items.values()) {
    if (item.state === 'acknowledged') continue;
    if (item.state === 'declined' && item.declineOp && applied.has(item.key)) continue;
    if (item.state === 'declined' && item.declineOp) {
      await applyOptOut(item.declineOp.op, item.declineOp.params);
      await appendEvent(await openJournal(journalRoot, runId), {
        step: 'checklist_opt_out',
        message: `applied decline opt-out for ${item.key}`,
        data: { key: item.key, op: item.declineOp.op },
      });
      optOutsApplied.push(item.key);
      continue;
    }
    if (item.state === 'declined') {
      throw new Error(
        `refusing to resume writers: blocksResume item '${item.key}' was declined and has no opt-out`,
      );
    }
    throw new Error(
      `refusing to resume writers: blocksResume item '${item.key}' is still pending`,
    );
  }

  const services = [...HELD_WRITER_SERVICES];
  if (deps.resume) await deps.resume(services);
  else await resumeAtCurrentPin(hostContext(runId), services);
  // Writers, including gbrain-serve, are up. Recapture with the settle loop
  // and a new seq: the hold-time capability-to.json has a null well-known,
  // and reconcile will not re-import that seq if we only overwrite the file.
  // A unit test injects resume and must also inject captureExec; otherwise
  // this would start Docker. The host CLI injects neither.
  if (deps.captureExec || !deps.resume) {
    await recaptureHeldCapability(runId, journalRoot, heldTargetVersion(events), deps.captureExec);
  }
  await appendEvent(await openJournal(journalRoot, runId), {
    step: 'completed',
    message: `resumed held writers for ${runId}`,
    data: { resumed: services },
  });
  return { runId, state: 'completed', resumed: services, alreadyCompleted: false, optOutsApplied };
}

if (import.meta.main) {
  // 0 ok · 1 the upgrade failed · 2 usage · 3 preflight refused, nothing touched
  // · 4 the rollback itself failed (break-glass).
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.cmd === 'status') {
      console.log(JSON.stringify(await statusOf(args.runId), null, 2));
      process.exit(0);
    }
    if (args.cmd === 'rollback') {
      const ctx = await buildContext(
        { to: process.env.GBRAIN_VERSION ?? '0.50.5.0', dryRun: false }, args.runId,
      );
      const r = await rollback(ctx, args.runId, {
        buildImages: (c, version) => buildImages(c, version),
        recreate: (c, services) => defaultRecreate(c, services),
        resume: (c) => resumeAtCurrentPin(c),
      });
      // The exit gate's definition of "restores the pre-upgrade state exactly".
      const beforePath = join(ctx.upgradeDir, 'digest-before.json');
      const before = JSON.parse(await readFile(beforePath, 'utf8')) as StateDigest;
      const parity = compareDigests(before, r.digest!);
      console.log(JSON.stringify({ ...r, parity }, null, 2));
      if (!parity.equal) {
        console.error(`[rollback] state differs after restore: ${parity.differing
          .map((p) => p.part).concat(parity.onlyInA, parity.onlyInB).join(', ')}`);
      }
      process.exit(r.ok && parity.equal ? 0 : 4);
    }
    if (args.cmd === 'resume-writers') {
      // No image rebuild and no pin move. Acks live in the control DB; the
      // journal still carries blocksResume and declineOp.
      console.log(JSON.stringify(await resumeWriters(args.runId, {
        decisions: (id) => checklistStates(id),
      }), null, 2));
      process.exit(0);
    }
    const ctx = await buildContext({ to: args.to, dryRun: args.cmd === 'plan' });
    const deps = await defaultDeps(ctx);
    if (args.cmd === 'plan') {
      console.log(JSON.stringify(await planUpgrade(ctx, deps), null, 2));
      process.exit(0);
    }
    if (!args.yes) {
      console.error('run requires --yes: this stops the stack, moves the pin and rebuilds images');
      process.exit(2);
    }
    const report = await runUpgrade(ctx, deps);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : (report.state === 'rollback_failed' ? 4 : 1));
  } catch (error) {
    if (error instanceof UsageError) { console.error(error.message); process.exit(2); }
    if (error instanceof PreflightRefusal) {
      console.error(`[upgrade] refused (${error.code}): ${error.message}`);
      console.error('Nothing was touched.');
      process.exit(3);
    }
    console.error(scrubOutput(String(error)));
    process.exit(1);
  }
}
