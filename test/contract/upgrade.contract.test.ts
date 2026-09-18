import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { GBRAIN_PIN, operationsPath } from '../../src/contracts/pin.ts';
import { composeUp, composeDown, resetBrain, BRAIN_DB_URL } from '../helpers/stack.ts';
import { composeExec } from '../../src/docker/host.ts';
import { detectUpdate } from '../../src/upgrade/detect.ts';
import { compareDoctor, type DoctorParity } from '../../src/upgrade/digest.ts';
import { sha256File, verifyManifest } from '../../src/upgrade/manifest.ts';
import { dockerVolumeDriver } from '../../src/upgrade/snapshot.ts';
import { verifySupervisorDrained, composeModel, drainLane, restoreLane, QUIESCE_ORDER, type OpsCaller } from '../../src/upgrade/quiesce.ts';
import { IN_FLIGHT_RUNS_SQL } from '../../scripts/upgrade.ts';
import type { SnapshotManifest } from '../../src/upgrade/types.ts';

// Gate A (Task 15) extends this SAME file with describe('Slice 3.5 seam gate
// A') — the RPC-boundary tests, targeting the main stack's gbrain-ops dev
// port rather than the slice0 harness execOperation uses here. Keep both
// suites in this one file so the registry's coverage check
// (test/unit/registry.test.ts, "every operation family is covered by a contract
// test file") only has one place to look for 'checkUpdate'/'postUpgrade'.

beforeAll(async () => {
  await composeUp();
  await resetBrain();
  assertOk(OPERATIONS.init!, await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 600_000 }));
}, 900_000);
afterAll(async () => { await composeDown(); }, 120_000);

describe('checkUpdate', () => {
  // U1: confirmed at the pin, not assumed. If this ever reads nonzero,
  // detectUpdate's whole "never branch on the exit code" design is wrong.
  test('check-update --json always exits 0, success or failure', async () => {
    const r = await execOperation(OPERATIONS.checkUpdate!, {}, { json: true, timeoutMs: 60_000 });
    expect(r.exitCode).toBe(0);
  }, 90_000);

  // L12: an accepted flag is not an implemented flag. Prove the documented
  // keys are really there, not merely that JSON.parse did not throw.
  test('the --json payload carries every documented key', async () => {
    const r = await execOperation(OPERATIONS.checkUpdate!, {}, { json: true, timeoutMs: 60_000 });
    expect(r.json).not.toBeNull();
    const body = r.json as Record<string, unknown>;
    for (const key of [
      'current_version', 'current_source', 'latest_version', 'update_available',
      'upgrade_command', 'release_url', 'changelog_diff', 'published_at',
    ]) {
      expect(Object.keys(body)).toContain(key);
    }
    // U2: confirmed, not assumed.
    expect(body.published_at).toBe('');
  }, 90_000);
});

describe('postUpgrade', () => {
  // Upstream's own claim: "Idempotent — safe to re-run any time." Two real
  // runs, not one — a single green run proves nothing about idempotency.
  test('post-upgrade is idempotent across two runs', async () => {
    const spec = OPERATIONS.postUpgrade!;
    assertOk(spec, await execOperation(spec, {}, { timeoutMs: 300_000 }));
    assertOk(spec, await execOperation(spec, {}, { timeoutMs: 300_000 }));
  }, 660_000);

  // G3/U3: no --json exists on post-upgrade. Confirm the registry agrees.
  test('post-upgrade has no --json', () => {
    expect(OPERATIONS.postUpgrade!.supportsJson).toBe(false);
  });
});

// ===========================================================================
// Task 15 — Slice 3.5 seam gate A.
//
// Every RPC-boundary test here targets the MAIN product stack's gbrain-ops at
// the dev override's published port (compose/docker-compose.dev.yml maps
// 3140:3140). execOperation targets the slice0 harness — the pinned
// brainstand/gbrain-base image, never rebuilt from the working tree — so a
// regenerated contracts/v<pin>/operations.json does not exist there and the
// RPC seam is untestable through it. Tests that only need the pinned binary
// (A5, A7) use execOperation; A3/A8/A9 shell docker directly.
// ===========================================================================

/** gbrain-ops's dev-published RPC port. */
const OPS = 'http://127.0.0.1:3140';

/** Bun loads `.env` into `process.env`; the fallback covers a non-Bun runner. */
function dotenvValue(key: string): string {
  try {
    return (readFileSync('.env', 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? '').trim();
  } catch { return ''; }
}

const OPS_TOKEN = process.env.OPS_RPC_TOKEN ?? dotenvValue('OPS_RPC_TOKEN');
const MAIN_COMPOSE = [
  '--env-file', '.env',
  '-f', 'compose/docker-compose.yml',
  '-f', 'compose/docker-compose.dev.yml',
];

type RawResult = { exitCode: number; stdout: string; stderr: string };

/** argv array only — no shell string anywhere in this file (G2 convention). */
async function run(argv: string[], timeoutMs = 600_000): Promise<RawResult> {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

/** Exec inside the MAIN stack's gbrain-ops (the same shape Slice 3's gate uses). */
function mainExec(argv: string[]): Promise<RawResult> {
  return run(['docker', 'compose', ...MAIN_COMPOSE, 'exec', '-T', 'gbrain-ops', ...argv]);
}

/** Index of the bracket closing the value that opens at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** The LAST balanced JSON value on stdout — check-update pretty-prints its JSON. */
function lastJsonValue(stdout: string): unknown {
  let found: unknown = null;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i]!;
    if (ch !== '{' && ch !== '[') continue;
    const end = balancedEnd(stdout, i);
    if (end < 0) continue;
    try { found = JSON.parse(stdout.slice(i, end + 1)); i = end; } catch { /* keep scanning */ }
  }
  return found;
}

type OpsRpcResult = {
  ok?: boolean; exitCode?: number; argv?: string[];
  stdout?: string; stderr?: string; json?: unknown; error?: string;
};

async function opsRpc(
  op: string, params: Record<string, unknown> = {},
  opts: { json?: boolean; dryRun?: boolean; timeoutMs?: number } = {},
): Promise<OpsRpcResult> {
  if (!OPS_TOKEN) throw new Error('OPS_RPC_TOKEN is empty (expected in .env) — every RPC call would 401');
  const res = await fetch(`${OPS}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPS_TOKEN}` },
    body: JSON.stringify({ op, params, json: opts.json, dryRun: opts.dryRun, timeoutMs: opts.timeoutMs }),
    signal: AbortSignal.timeout((opts.timeoutMs ?? 600_000) + 30_000),
  });
  const body = (await res.json().catch(() => null)) as OpsRpcResult | null;
  const result: OpsRpcResult = body ?? {};
  if (result.json == null && typeof result.stdout === 'string') {
    result.json = lastJsonValue(result.stdout);
  }
  return result;
}

/** A throwaway container on the pinned image with no network and its own tmpfs
 *  GBRAIN_HOME, so the cached last-update-check cannot answer for the network. */
async function dockerRunOffline(argv: string[]): Promise<RawResult> {
  return run([
    'docker', 'run', '--rm', '--network', 'none', '--tmpfs', '/gb',
    '-e', 'GBRAIN_HOME=/gb', `brainstand/gbrain-base:${GBRAIN_PIN}`, ...argv,
  ], 180_000);
}

/** The file plane's config, read through gbrain-ops (S3 — the lane fileplane.ts owns). */
async function readGbrainConfig(): Promise<Record<string, any>> {
  const r = await mainExec(['cat', '/srv/gbrain-home/.gbrain/config.json']);
  if (r.exitCode !== 0) throw new Error(`reading gbrain config failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as Record<string, any>;
}

/** D5 parity's gate verdict: fail on any regression or a non-ok schema_version. */
function gateVerdict(p: DoctorParity): 'pass' | 'fail' {
  return p.regressed.length === 0 && p.schemaVersionOk ? 'pass' : 'fail';
}

function mutateCheck(report: any, name: string, status: string): any {
  return { ...report, checks: report.checks.map((c: any) => (c.name === name ? { ...c, status } : c)) };
}

function writeAuditFixture(events: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'slice35-audit-'));
  writeFileSync(join(dir, 'audit.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

/** The negative fixtures parse a local file; the status read is a stub so the
 *  fixture does not depend on a live supervisor. */
const staticOps: OpsCaller = {
  kind: 'stub',
  auditTail: async () => [],
  supervisorStatus: async () => ({ running: false, workers: [] }),
};

const SLICE0_AUDIT_DIR = '/srv/gbrain-home/.gbrain/audit';
/** `Bun.Glob`/`Bun.file`, deliberately NOT `require` — this image's bun -e
 *  swallows a late uncaught exception when the eval contains `require`. */
const AUDIT_TAIL_PROGRAM = [
  "const g = new Bun.Glob('/srv/gbrain-home/.gbrain/audit/*.jsonl');",
  "let out = '';",
  'for await (const f of g.scan()) { out += await Bun.file(f).text(); }',
  "console.log(JSON.stringify(out.split('\\n').filter(Boolean).slice(-50)));",
].join(' ');

/** A slice0-scoped OpsCaller: the supervisor A7 starts lives in the slice0
 *  harness, so its audit must be read there, not from the main stack's ops. */
const slice0OpsCaller: OpsCaller = {
  kind: 'stub',
  async auditTail() {
    const r = await composeExec('gbrain-ops', ['bun', '-e', AUDIT_TAIL_PROGRAM]);
    if (r.exitCode !== 0) return [];
    try { return JSON.parse(r.stdout.trim()) as string[]; } catch { return []; }
  },
  async supervisorStatus() {
    const r = await composeExec('gbrain-ops', ['gbrain', 'jobs', 'supervisor', 'status', '--json']);
    const j = lastJsonValue(r.stdout) as { running?: boolean; workers?: unknown[] } | null;
    return j ? { running: !!j.running, workers: j.workers ?? [] } : null;
  },
};

async function waitForSupervisorRunning(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await execOperation(OPERATIONS['jobs.supervisorStatus']!, {}, { json: true, timeoutMs: 60_000 });
    const j = r.json as { running?: boolean } | null;
    if (j?.running) return;
    if (Date.now() > deadline) throw new Error(`supervisor never reported running within ${timeoutMs}ms`);
    await Bun.sleep(1000);
  }
}

async function seedThrowawayVolume(volume: string, fileName: string, content: string): Promise<void> {
  let r = await run(['docker', 'volume', 'create', volume], 60_000);
  if (r.exitCode !== 0) throw new Error(`docker volume create failed: ${r.stderr}`);
  r = await run([
    'docker', 'run', '--rm', '--entrypoint', 'sh', '-v', `${volume}:/v`,
    `brainstand/gbrain-base:${GBRAIN_PIN}`,
    '-c', `printf '%s' '${content.replace(/'/g, "'\\''")}' > /v/${fileName}`,
  ], 60_000);
  if (r.exitCode !== 0) throw new Error(`seeding volume ${volume} failed: ${r.stderr}`);
}

/** Mirrors the e2e suites' probe: is `docker compose` usable at all? */
async function probeDockerCompose(): Promise<boolean> {
  try { return (await run(['docker', 'compose', 'version'], 30_000)).exitCode === 0; } catch { return false; }
}
const dockerAvailable = await probeDockerCompose();

const RUN_ID = randomUUID().slice(0, 8);
const VOL = `slice35-gate-a-${RUN_ID}`;
const OUT = mkdtempSync(join(tmpdir(), 'slice35-gate-a-out-'));
let manifestFromA8: SnapshotManifest;

describe('Slice 3.5 seam gate A', () => {
  test('slice3.5 contract tests are not silently skipped', () => {
    if (dockerAvailable) return;
    if (process.env.BRAINSTAND_ALLOW_SKIP_SLICE35_CONTRACT === '1') return;
    throw new Error(
      'docker compose is not usable, so the slice3.5 contract suite was skipped rather than run. '
        + 'Install/start Docker, then rerun:\n\n  bun test test/contract/upgrade.contract.test.ts\n\n'
        + 'If skipping is genuinely intended, set BRAINSTAND_ALLOW_SKIP_SLICE35_CONTRACT=1.',
    );
  });

  test('A1. the emitted allowlist carries checkUpdate and postUpgrade', async () => {
    // operationsPath() comes from src/contracts/pin.ts (Task 2) — NOT a literal
    // 'contracts/v0.50.0.0/...', which is the defect D8 exists to kill.
    const doc = JSON.parse(readFileSync(operationsPath(), 'utf8'));
    expect(doc.gbrainVersion).toBe(GBRAIN_PIN);
    const byId = Object.fromEntries(doc.operations.map((o: any) => [o.id, o]));
    expect(byId['checkUpdate']).toBeDefined();
    expect(byId['postUpgrade']).toBeDefined();
    // 33 at Slice 3.5 close (31 at Slice 3 close + `checkUpdate` and
    // `postUpgrade`) + 1: Slice 4 added `page.delete` — F16's
    // `delete <slug> --source-id <id> --purge`, the operation the revert's
    // re-index needs to remove the page an agent run wrote
    // (docs/slice-4-findings.md, F16). The pinned
    // contracts/v0.50.5.0/operations.json carries it.
    expect(doc.operations.length).toBe(34);
    // U1/U3: neither declares a dry run, and only checkUpdate has --json.
    expect(byId['checkUpdate'].supportsJson).toBe(true);
    expect(byId['postUpgrade'].supportsJson).toBe(false);
    expect(byId['checkUpdate'].privilege).toBe('read-only');
    expect(byId['postUpgrade'].privilege).toBe('brain-db');

    // The seam itself: the id is reachable, not merely declared.
    const r = await opsRpc('checkUpdate', {}, { json: true });
    expect(r.error).toBeUndefined(); // NOT "unknown operation"
  }, 120_000);

  test('A2. check-update --json emits the documented key set, through the RPC', async () => {
    const r = await opsRpc('checkUpdate', {}, { json: true });
    expect(r.exitCode).toBe(0);
    const body = r.json as Record<string, unknown>;
    for (const k of ['current_version', 'current_source', 'latest_version', 'update_available',
      'upgrade_command', 'release_url', 'changelog_diff', 'published_at']) {
      expect(Object.keys(body)).toContain(k);
    }
    expect(body.current_source).toBe('package-json');
    expect(body.current_version).toBe(GBRAIN_PIN);
    // U2: the source has no timestamp. If this ever stops being '', the banner
    // may start showing a release date — until then it must not pretend to.
    expect(body.published_at).toBe('');
    expect(typeof body.update_available).toBe('boolean');
    // L12: an accepted flag is not an implemented flag. This is the proof that
    // --json is real for THIS command, never an assumption inherited from another.
    expect(r.json).not.toBeNull();
  }, 120_000);

  test('A3. check-update exits 0 when the network is genuinely gone, and says so', async () => {
    // U1 is the single most dangerous upstream fact in this slice: there is no
    // process.exit() anywhere in runCheckUpdate, so an exit-code check is a
    // silent lie. Asserting `expect([0]).toContain(r.exitCode)` on a HEALTHY
    // network proves nothing — it would pass even if upstream added an exit
    // code tomorrow, because the happy path exits 0 either way.
    //
    // So the failure is OBSERVED, not hoped for: a throwaway container on the
    // pinned image with `--network none` and its own tmpfs GBRAIN_HOME (so the
    // cached last-update-check cannot answer instead of the network).
    const r = await dockerRunOffline(['gbrain', 'check-update', '--json']);

    const body = lastJsonValue(r.stdout) as Record<string, unknown> | null;
    // The assertion is "we induced a real failure", and it FAILS rather than
    // passes vacuously if the container reached the network after all.
    if (!body || body.error === undefined) {
      throw new Error(
        `the offline probe did not fail: exit ${r.exitCode}, stdout ${r.stdout.slice(0, 400)}. `
        + 'U1 cannot be proven against a healthy network — fix the probe, never the assertion.',
      );
    }
    expect(body.error).toBe('network_error');
    expect(r.exitCode).toBe(0); // U1, observed
    expect(body.update_available).toBe(false);

    // Honesty rule 1 at the seam: our parser must NOT read that as "up to date".
    const parsed = detectUpdate(body);
    expect(parsed.status).toBe('unknown');
    expect(parsed.error).toBe('network_error');
    expect(parsed.candidateVersion).toBeNull();
  }, 180_000);

  test('A4. post-upgrade is idempotent and what it wrote to config.json is observable', async () => {
    // U4: applySelfUpgradeSetup() does a LOCK-FREE read-modify-write of
    // ~/.gbrain/config.json (self_upgrade.*), which is why our lane only ever
    // runs it inside the quiesce window behind the ops advisory lock (S3).
    const before = await readGbrainConfig();

    const first = await opsRpc('postUpgrade', {}, {});
    expect(first.exitCode).toBe(0);
    const afterFirst = await readGbrainConfig();
    expect(afterFirst.self_upgrade?.mode).toBe('notify'); // set when unset
    expect(afterFirst.self_upgrade?.mode_prompted).toBe(true);

    const second = await opsRpc('postUpgrade', {}, {});
    expect(second.exitCode).toBe(0);
    const afterSecond = await readGbrainConfig();
    // Idempotent means the SECOND run changed nothing, not merely exited 0.
    expect(afterSecond.self_upgrade).toEqual(afterFirst.self_upgrade);

    // U5, and the reason we tolerate the write at all: the env var overrides
    // config, so `notify` in config.json does not re-arm the self-upgrade
    // channel in our containers. Assert the override is still IN PLACE.
    const env = await mainExec(['printenv', 'GBRAIN_SELF_UPGRADE_MODE']);
    expect(env.stdout.trim()).toBe('off');
    expect(before).toBeTruthy(); // the file existed before we touched it
  }, 600_000);

  test('A5. apply-migrations exits 0 on an up-to-date brain and has no JSON to parse', async () => {
    const spec = OPERATIONS.applyMigrations!;
    // G3/U3: there is no --json. buildArgv REFUSES to emit one for a spec that
    // does not declare it — a stronger guarantee than silently dropping it.
    expect(spec.supportsJson).toBe(false);
    expect(() => buildArgv(spec, { yes: true, nonInteractive: true }, { json: true }))
      .toThrow('does not support --json');
    expect(buildArgv(spec, { yes: true, nonInteractive: true }))
      .toEqual(['apply-migrations', '--yes', '--non-interactive']);

    const r = await execOperation(spec, { yes: true, nonInteractive: true }, { timeoutMs: 300_000 });
    expect(r.exitCode).toBe(0);
    expect(r.json).toBeNull(); // prose only; parsing it is a G3 violation
    // U3: 0 / 1 / 2 are the whole universe. A code outside it means upstream
    // changed and our runner's branching is now incomplete.
    expect([0, 1, 2]).toContain(r.exitCode);
    // The declared contract agrees.
    expect([...spec.okExitCodes]).toEqual([0]);
  }, 600_000);

  test('A6. doctor --json has the documented keys, no blockers, and the comparator works on it', async () => {
    const r = await opsRpc('doctor', {}, { json: true });
    const report = r.json as any;
    expect(Object.keys(report)).not.toContain('blockers'); // L4, re-asserted
    for (const k of ['schema_version', 'status', 'health_score', 'category_scores', 'checks']) {
      expect(Object.keys(report)).toContain(k);
    }
    expect(['healthy', 'warnings', 'unhealthy']).toContain(report.status);
    expect(report.checks.every((c: any) => ['ok', 'warn', 'fail'].includes(c.status))).toBe(true);
    expect(report.checks.some((c: any) => c.name === 'schema_version')).toBe(true);

    // D5, against a REAL report rather than a literal fixture. Task 12's
    // compareDoctor returns DoctorParity (its own type), so the plan's literal
    // toEqual is scoped to the three lists it names.
    const same = compareDoctor(report, report);
    expect({ regressed: same.regressed, newChecks: same.newChecks, resolved: same.resolved })
      .toEqual({ regressed: [], newChecks: [], resolved: [] });

    const firstOk = report.checks.find((c: any) => c.status === 'ok');
    const regressedReport = mutateCheck(report, firstOk.name, 'warn');
    expect(compareDoctor(report, regressedReport).regressed.map((c: any) => c.name))
      .toEqual([firstOk.name]);
    expect(gateVerdict(compareDoctor(report, regressedReport))).toBe('fail');

    // A check upstream ADDS is news, not a regression we caused.
    const widened = { ...report, checks: [...report.checks, { name: 'brand_new_upstream_check', status: 'warn', message: 'x' }] };
    const widenedDiff = compareDoctor(report, widened);
    expect(widenedDiff.regressed).toEqual([]);
    expect(widenedDiff.newChecks.map((c: any) => c.name)).toEqual(['brand_new_upstream_check']);
    expect(gateVerdict(widenedDiff)).toBe('pass');

    // U7: schema_version warn is the ONLY way to see "binary behind DB", and
    // `warnings` exits 0 — so the gate must fail on it even at exit 0.
    expect(gateVerdict(compareDoctor(report, mutateCheck(report, 'schema_version', 'warn')))).toBe('fail');
    expect(r.exitCode).toBe(report.status === 'unhealthy' ? 1 : 0);
  }, 900_000);

  test('A7. the drain proof distinguishes a clean exit from a crash', async () => {
    // L2: `start --detach` ALWAYS exits 0, so the start code is not evidence.
    // GBRAIN_AUDIT_DIR is set on the start so the detached supervisor writes a
    // deterministic audit path the slice0OpsCaller can read back.
    // L2: a stale pidfile makes `status` report running and `start --detach`
    // exit 0 without starting anything, and a stale worker registry makes the
    // drain proof read someone else's state. Start from a clean supervisor state.
    await execOperation(OPERATIONS['jobs.supervisorStop']!, {}, { timeoutMs: 120_000 });
    await composeExec('gbrain-ops', ['rm', '-rf', '/root/.gbrain', '/srv/gbrain-home/.gbrain']);

    const start = await execOperation(OPERATIONS['jobs.supervisor']!, { detach: true, concurrency: '2' },
      { json: true, timeoutMs: 120_000, env: { GBRAIN_AUDIT_DIR: SLICE0_AUDIT_DIR } });
    expect(start.exitCode).toBe(0);
    await waitForSupervisorRunning(60_000); // poll status --json, never trust start

    const stop = await execOperation(OPERATIONS['jobs.supervisorStop']!, {}, { timeoutMs: 90_000 });
    expect(stop.exitCode).toBe(0); // reason:'drained' — NOT yet evidence (U9)

    // The supervisor lives in the slice0 harness, so its audit is read there
    // through the SAME verifySupervisorDrained reader (via an injected ops caller).
    const proof = await verifySupervisorDrained({ ops: slice0OpsCaller });

    // The audit-derived positive IS real: the supervisor wrote a clean
    // shutting_down event, and the reader read its exit code and reason right.
    expect(proof.decidingEvent?.event).toBe('shutting_down');
    expect(proof.exitCode).toBe(0); // ExitCodes.CLEAN
    expect(proof.reason).not.toBeNull();
    expect(['SIGTERM', 'SIGINT']).toContain(proof.reason as string);
    expect(proof.running).toBe(false);

    // But a clean supervisor exit is NOT a clean drain (honesty rule 3): at this
    // pin `gbrain jobs supervisor stop` leaves the worker process ALIVE. The pid
    // in /srv/gbrain-home/.gbrain/workers/worker-*.json stays in /proc for
    // minutes (F2 in docs/slice-3.5-findings.md), so verifySupervisorDrained
    // reads live workers and correctly refuses to call this clean.
    //
    // This is a HONEST-VERDICT assertion, deliberately not the plan's
    // clean===true. The plan's positive is proven end-to-end by Gate C's C6
    // against the real quiesce, which stops the gbrain-worker CONTAINER: the
    // supervisor is pid 1 there and its workers die with the container (F1
    // records a real-quiesce run with clean:true). A detached supervisor inside
    // slice0's gbrain-ops was tried at the container boundary first and never
    // receives SIGTERM through tini, so it writes no clean event at all and
    // cannot stand in for the real quiesce. Deviation reported in worker_done.
    expect(proof.workers.length).toBeGreaterThan(0);
    expect(proof.clean).toBe(false);
    expect(proof.classification).toBe('unproven');

    // The load-bearing honesty-rule-3 property, deterministically: a clean
    // `shutting_down{exit_code:0}` audit event with a LIVE worker must NOT be
    // recorded clean. This is the plan's negative half, kept and sharpened.
    const cleanEventLiveWorker = await verifySupervisorDrained({
      auditDir: writeAuditFixture([{ event: 'shutting_down', exit_code: 0, reason: 'SIGTERM' }]),
      ops: {
        kind: 'stub',
        auditTail: async () => [],
        supervisorStatus: async () => ({ running: false, workers: [{ pid: 4242 }] }),
      },
    });
    expect(cleanEventLiveWorker.exitCode).toBe(0);
    expect(cleanEventLiveWorker.clean).toBe(false);
    expect(cleanEventLiveWorker.classification).toBe('unproven');

    // The negative half is a REAL audit file parsed by the SAME reader, written
    // into a throwaway directory — not a hand-mocked return value. We do not
    // induce MAX_CRASHES in a live supervisor; that is stated rather than
    // dressed up.
    const dir = writeAuditFixture([{ event: 'stopped', exit_code: 1, reason: 'MAX_CRASHES' }]);
    expect((await verifySupervisorDrained({ auditDir: dir, ops: staticOps })).clean).toBe(false);

    // L3: 4 is LOCK_LOST — "someone else owns this", not an undifferentiated crash.
    const lost = writeAuditFixture([{ event: 'stopped', exit_code: 4, reason: 'SIGTERM' }]);
    const lostProof = await verifySupervisorDrained({ auditDir: lost, ops: staticOps });
    expect(lostProof.clean).toBe(false);
    expect(lostProof.classification).toBe('lock_lost');
  }, 600_000);

  test('A8. a snapshot manifest verifies against the artifacts it names', async () => {
    try {
      // A real driver run against a throwaway volume: no product service is
      // touched, and the docker-volume driver's own argv path is exercised.
      await seedThrowawayVolume(VOL, 'canary.txt', 'gate-a\n');
      const taken = await dockerVolumeDriver.take({
        runId: `gate-a-${RUN_ID}`, volumes: [VOL], databases: [], outDir: OUT,
      });
      expect(taken.artifacts.length).toBe(1);
      expect(taken.artifacts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(taken.artifacts[0]!.bytes).toBeGreaterThan(0);
      expect(taken.driver).toBe('docker-volume');
      // Artifact `path` is a basename (Task 4); pass the snapshot dir explicitly
      // (the canonical verifyManifest(manifest, dir?) signature).
      expect(await verifyManifest(taken, OUT)).toEqual({ ok: true, mismatches: [] });

      // Re-hashing off disk, not off the manifest's own memory.
      expect(await sha256File(join(OUT, taken.artifacts[0]!.path))).toBe(taken.artifacts[0]!.sha256);
      manifestFromA8 = taken;
    } finally {
      // Kept for A9; volume/dir cleanup happens at the end of A9.
    }
  }, 600_000);

  test('A9. a tampered artifact fails verification', async () => {
    try {
      // Honesty rule 10: a snapshot nobody verified is not a backup. One
      // appended byte must be enough — this makes the checksum real.
      const artifactPath = join(OUT, manifestFromA8.artifacts[0]!.path);
      appendFileSync(artifactPath, '\0');
      const name = manifestFromA8.artifacts[0]!.name;
      const verdict = await verifyManifest(manifestFromA8, OUT);
      expect(verdict.ok).toBe(false);
      // Task 4's reader reports "<name>: sha256 mismatch", not the bare name.
      expect(verdict.mismatches).toEqual([`${name}: sha256 mismatch`]);

      // A missing artifact is a failure, never a skip.
      rmSync(artifactPath);
      expect((await verifyManifest(manifestFromA8, OUT)).ok).toBe(false);
    } finally {
      await run(['docker', 'volume', 'rm', '-f', VOL], 60_000);
      rmSync(OUT, { recursive: true, force: true });
    }
  }, 300_000);
});

// ===========================================================================
// Task 14 — the upgrade lane's boundary. Two facts that source text cannot
// prove: the query the new preflight refusal runs is valid against THIS
// control schema (the L9/F3 failure class), and the quiesce lane is derived
// from THIS host's compose model, so the runner entry appears exactly when the
// runner profile does (D12 off by default, D13 first when it is on).
// ===========================================================================
describe('Slice 4 upgrade lane (Task 14)', () => {
  // The prefix the host CLI itself builds (scripts/upgrade.ts's COMPOSE), not
  // the dev override: this is the project a real upgrade quiesces.
  const HOST_COMPOSE = [
    'docker', 'compose', '--env-file', '.env', '-f', 'compose/docker-compose.yml',
  ];
  const psqlArgv = (sql: string) => [
    ...HOST_COMPOSE, 'exec', '-T', 'postgres', 'psql', '-U', 'gbrain', '-d', 'control', '-tAc', sql,
  ];

  test.skipIf(!dockerAvailable)('the in-flight-run query answers from the live control ledger', async () => {
    const r = await run(psqlArgv(IN_FLIGHT_RUNS_SQL), 60_000);
    expect(r.exitCode).toBe(0);
    const inFlight = JSON.parse(r.stdout.trim()) as { id: string; state: string }[];
    expect(Array.isArray(inFlight)).toBe(true);
    for (const row of inFlight) expect(row.state).toBe('running');

    // The refusal fires on a HELD claim and on nothing else. An independent
    // count of `state = 'running'` must agree, so the row set cannot be
    // whatever the query happens to select: `pending` is a materialized FUTURE
    // occurrence (a row every enabled schedule has all day), and refusing on it
    // would refuse every upgrade forever.
    const running = await run(psqlArgv("select count(*) from schedule_runs where state = 'running'"), 60_000);
    expect(running.exitCode).toBe(0);
    expect(inFlight.length).toBe(Number(running.stdout.trim()));
    console.log(`MEASURED in-flight runs on this ledger: ${inFlight.length} `
      + `(ids: ${JSON.stringify(inFlight.map((row) => row.id))})`);
  }, 120_000);

  test.skipIf(!dockerAvailable)('the quiesce lane is derived from this host\'s compose model', async () => {
    const model = await composeModel(HOST_COMPOSE);
    if (model === 'unknown') throw new Error('the live compose project could not be rendered');

    // Every writer the lane has always drained is in this project; the runner
    // is the only entry whose presence follows a profile.
    for (const svc of ['scheduler', 'gbrain-worker', 'control-plane', 'gbrain-serve', 'gbrain-ops']) {
      expect(model.active.has(svc)).toBe(true);
    }

    const runnerOn = model.active.has('agent-runner');
    const lane = drainLane(model);
    const back = restoreLane(model);
    console.log(`MEASURED quiesce lane on this host: drain [${lane.join(', ')}] `
      + `restore [${back.join(', ')}] (runner profile ${runnerOn ? 'ON' : 'OFF'}, `
      + `runner container ${model.containers.has('agent-runner') ? 'present' : 'absent'})`);

    if (runnerOn) {
      // D13: the one consumer that keeps writing after the scheduler stops
      // materializing drains first, and is restored last.
      expect(lane).toEqual([...QUIESCE_ORDER]);
      expect(lane[0]).toBe('agent-runner');
      expect(back).toEqual([...QUIESCE_ORDER].reverse());
    } else {
      // D12: the runner is off by default, and the lane may never name a
      // service this project does not have — `docker compose stop` on one exits
      // non-zero, and quiesce() throws on a non-zero stop, so a bare
      // QUIESCE_ORDER addition would break every deployment without a runner.
      // resume() reads the same model, which is what keeps an upgrade from
      // starting a container the operator chose not to have.
      expect(back).not.toContain('agent-runner');
      expect(back).toEqual([...QUIESCE_ORDER].filter((svc) => svc !== 'agent-runner').reverse());
      if (model.containers.has('agent-runner')) {
        // A runner left over from before the profile was disabled is still a
        // live writer: drained, never restored.
        expect(lane[0]).toBe('agent-runner');
      } else {
        expect(lane).toEqual([...QUIESCE_ORDER].filter((svc) => svc !== 'agent-runner'));
      }
    }
  }, 120_000);
});
