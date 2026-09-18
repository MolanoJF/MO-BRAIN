import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OPERATIONS } from '../contracts/registry.ts';
import { writePin } from '../contracts/pin.ts';
import { verifyManifest } from './manifest.ts';
import {
  SNAPSHOT_DATABASES, snapshotVolumes, dockerVolumeDriver, type SnapshotContext,
} from './snapshot.ts';
import { quiesce as realQuiesce, resume as realResume } from './quiesce.ts';
import type {
  DoctorBaseline, DoctorCheckSummary, SnapshotManifest, UpgradeContext,
} from './types.ts';

export type DigestPart = { name: string; sha256: string; items: number; scope: string };

/** One Space's content identity: its id, its git tree hash, its tracked files. */
export type DigestSource = { id: string; treeHash: string; files: number };

export type StateDigest = {
  takenAt: string;
  gbrainVersion: string;
  /** Key NAMES only (S3c). Kept unhashed so a run can name what post-upgrade added. */
  configKeys: string[];
  /** Committed pages across every Space repo (tracked files), a total the digest
   *  can compare without a search whose scope could shrink silently (L13). */
  pages: number;
  /** Per-Space id + git tree hash — where page CONTENT identity lives. */
  sources: DigestSource[];
  /** Exact control-DB row counts, keyed by table, minus this run's own bookkeeping. */
  controlRowCounts: Record<string, number>;
  /** The file plane as its own part (L7); also present in `parts`. */
  filePlane: DigestPart;
  parts: DigestPart[];
};

/**
 * Tables the digest does NOT count. They record the upgrade itself: rollback
 * restores the control DB from the snapshot and the reconciler replays the run
 * from the journal (D2), so counting them would assert that a successful
 * rollback left no trace of the attempt. The list is hashed into the part, so
 * widening it changes the digest instead of quietly excusing a difference.
 *
 * `schedule_runs`/`schedule_alerts` (Task 17): the scheduler appends to these
 * on a live tick, so any two observations of a running stack differ by however
 * many schedules fired between them. They are run HISTORY, not content, and
 * the snapshot still restores them; gating "restores exactly" on a
 * continuously-growing log would instead assert that no schedule fired during
 * the gate, which rollback does not promise. Measured: +6 `schedule_runs`
 * between a pre-upgrade digest and the post-rollback digest of an otherwise
 * identical control DB (docs/slice-3.5-findings.md, F3).
 *
 * `agent_runs`/`agent_run_events`/`agent_run_usage` (Slice 4 Task 14, L9): the
 * same class, from the runner's own ledger — a run in flight appends events,
 * appends usage rows and rewrites its own rollup (`costUsd`, which C3 asserts
 * equals `SUM(agent_run_usage.costUsd)`, so these three move together). Run
 * history, not content, and the snapshot restores all three the same way. A
 * digest that counted them would compare two observations of a moving ledger
 * and break the parity gate exactly as F3's row growth did.
 *
 * `runner_presence` (Slice 4 D2): the runner rewrites its own sighting row on
 * every claim request — once per 25s long poll — so it moves while the brain
 * does not. Nothing is lost by not counting it: it holds no work, and a
 * rollback that restored an older sighting would be corrected by the very next
 * poll.
 */
export const UNCOUNTED_TABLES = [
  'audit_log', 'capability_snapshots', 'playbook_ledger',
  'upgrade_checklist_items', 'upgrade_events', 'upgrade_runs',
  'schedule_runs', 'schedule_alerts',
  'agent_runs', 'agent_run_events', 'agent_run_usage',
  'runner_presence',
] as const;

/** Exact counts per public table. n_live_tup is an estimate and will not do. */
const ROW_COUNT_SQL =
  "select table_name || '|' || (xpath('/row/c/text()', x))[1]::text as row from (" +
  "select table_name, query_to_xml(format('select count(*) as c from %I.%I', table_schema," +
  ' table_name), false, true, \'\') as x from information_schema.tables' +
  " where table_schema = 'public' and table_type = 'BASE TABLE') t order by table_name";

function hashPart(name: string, scope: string, lines: string[]): DigestPart {
  const body = [name, scope, ...[...lines].sort()].join('\n');
  return { name, scope, items: lines.length, sha256: createHash('sha256').update(body).digest('hex') };
}

/**
 * Parse JSON that may be preceded by a warning line on stdout. The previous
 * `slice(Math.max(indexOf('{'), indexOf('[')))` was wrong: for an object body it
 * picked the inner `[` and left the trailing `}` in the slice, which is not
 * JSON. Parse the whole body first, and only fall back to slicing from the
 * first brace/bracket when a real prefix is present.
 */
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* tolerate a prefixed line */ }
  const i = trimmed.search(/[[{]/);
  if (i < 0) throw new Error(`no JSON in command output: ${trimmed.slice(0, 120)}`);
  return JSON.parse(trimmed.slice(i));
}

export type DigestDeps = {
  exec(ctx: UpgradeContext, service: string, argv: string[]): Promise<{ exitCode: number; stdout: string }>;
};

async function defaultExec(ctx: UpgradeContext, service: string, argv: string[]) {
  const p = Bun.spawn([...ctx.compose, 'exec', '-T', service, ...argv], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, exitCode] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { exitCode, stdout };
}

/** Sorted dotted key paths of the file-plane config. Names only, never values. */
const CONFIG_KEYS_PROGRAM = `
const home = process.env.GBRAIN_HOME ?? '/srv/gbrain-home';
let keys = [];
try {
  const raw = await Bun.file(home + '/.gbrain/config.json').text();
  const flat = (o, p) => Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? flat(v, p + k + '.') : [p + k]);
  keys = flat(JSON.parse(raw), '').sort();
} catch {}
console.log(JSON.stringify(keys));
`;

/** Tree hash + tracked-file count per Space repo. */
const REPO_TREES_PROGRAM = `
const { readdirSync } = require('node:fs');
const root = process.env.BRAIN_REPOS ?? '/srv/brain-repos';
const out = [];
for (const e of readdirSync(root, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const git = (args) => {
    const p = Bun.spawnSync(['git', '-C', root + '/' + e.name, ...args]);
    return new TextDecoder().decode(p.stdout).trim();
  };
  const files = git(['ls-files']).split('\\n').filter(Boolean).length;
  out.push(e.name + ':' + git(['rev-parse', 'HEAD^{tree}']) + ':' + files);
}
console.log(JSON.stringify(out.sort()));
`;

/**
 * L7: the FILE PLANE must be IN the digest. Relative path + size of every
 * regular file under GBRAIN_HOME, excluding volatile scratch/audit/lock state
 * so an upgrade's own churn cannot masquerade as lost content. Names and sizes
 * only — no file contents leave the container.
 */
const FILE_PLANE_PROGRAM = `
const { readdirSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const root = process.env.GBRAIN_HOME ?? '/srv/gbrain-home';
// workers (Task 17): the resumed supervisor writes a worker registry file
// under GBRAIN_HOME/.gbrain/workers on every start, so it is process
// bookkeeping of the same class as the audit/lock files already skipped — not
// file-plane content the rollback is meant to bring back.
const skip = /(^|[\\/])(audit|logs?|tmp|sessions?|cache|node_modules|workers)([\\/]|$)|[.](lock|tmp)$/;
// gbrain's OWN runtime state under .gbrain/ (Task 19, F8): the playbook
// migration ledger, credential handoffs, a per-run secret, and the update /
// model / backup caches are written by gbrain itself on every run, so an
// upgrade+rollback can never restore them byte-for-byte. configKeys already
// carries the config's key NAMES, so this part is CONTENT, not gbrain's
// bookkeeping. Without this, C4/C11's "restores exactly" compares files no
// rollback could hold constant.
const runtime = /(^|[\\/])\.gbrain[\\/](migrations|credential-deliveries|run)([\\/]|$)|(^|[\\/])\.gbrain[\\/](last-update-check|model-cache\.json|preferences\.json|backup-status\.json|backup-nag-state\.json)$/;
const out = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(root, p);
    if (skip.test(rel) || runtime.test(rel)) continue;
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.isFile()) continue;
    try { out.push(rel + '|' + statSync(p).size); } catch {}
  }
};
try { walk(root); } catch {}
console.log(JSON.stringify(out.sort()));
`;

/**
 * The definition of "restores the pre-upgrade state exactly" that the exit gate
 * asserts. Four parts plus the pin, every one of them computed through a
 * published contract or our own file plane (G3).
 */
export async function stateDigest(
  ctx: UpgradeContext, deps: DigestDeps = { exec: defaultExec },
): Promise<StateDigest> {
  const pin = (await readFile(ctx.envPath, 'utf8')).match(/^GBRAIN_VERSION=(.*)$/m)?.[1]?.trim() ?? '';

  // 1. The brain's source set, via the registry's own argv. NOT a search: a
  //    non-empty --federated-read is the FULL scope (L13) and an unqualified
  //    read only sees sources whose config.federated is literally true (L6), so
  //    a search-based set can shrink silently and still look equal.
  const statusArgv = OPERATIONS['sources.status']!.argv;
  const sourcesRaw = await deps.exec(ctx, 'gbrain-ops', ['gbrain', ...statusArgv, '--json']);
  const parsed = parseJsonLoose(sourcesRaw.stdout);
  const rows: Record<string, unknown>[] = Array.isArray(parsed)
    ? parsed as Record<string, unknown>[]
    : Object.values(parsed as Record<string, unknown>).find(Array.isArray) as Record<string, unknown>[] ?? [];
  // Shape-tolerant projection: identity plus any count-like number, timestamps
  // dropped. No contract test pins this JSON's exact field list, so the digest
  // must not depend on one it invented.
  const sourcesStatus = rows.map((r) => {
    const id = String(r.id ?? r.source_id ?? r.name ?? '');
    const counts = Object.entries(r)
      .filter(([k, v]) => typeof v === 'number' && /count|documents|pages|chunks/i.test(k))
      .map(([k, v]) => `${k}=${v}`).sort();
    return [id, ...counts].join('|');
  });

  // 2. Git tree hashes — where page CONTENT identity actually lives.
  const reposRaw = await deps.exec(ctx, 'gbrain-ops', ['bun', '-e', REPO_TREES_PROGRAM]);
  const repos = JSON.parse(reposRaw.stdout.trim()) as string[];
  const sources: DigestSource[] = repos.map((line) => {
    const [id = '', treeHash = '', files = '0'] = line.split(':');
    return { id, treeHash, files: Number(files) };
  });
  const pages = sources.reduce((n, s) => n + s.files, 0);

  // 3. File-plane config KEY NAMES (S3c). Values never leave the container.
  const keysRaw = await deps.exec(ctx, 'gbrain-ops', ['bun', '-e', CONFIG_KEYS_PROGRAM]);
  const configKeys = JSON.parse(keysRaw.stdout.trim()) as string[];

  // 3b. L7: the file plane itself is a part, not an afterthought.
  const filePlaneRaw = await deps.exec(ctx, 'gbrain-ops', ['bun', '-e', FILE_PLANE_PROGRAM]);
  const filePlaneLines = JSON.parse(filePlaneRaw.stdout.trim()) as string[];
  const filePlane = hashPart(
    'filePlane', 'GBRAIN_HOME regular files: relative path + size; volatile scratch/audit/lock excluded',
    filePlaneLines,
  );

  // 4. Exact control-DB row counts, minus this system's own bookkeeping.
  const countsRaw = await deps.exec(ctx, 'postgres',
    ['psql', '-U', 'gbrain', '-d', 'control', '-tAc', ROW_COUNT_SQL]);
  const controlRows = countsRaw.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !(UNCOUNTED_TABLES as readonly string[]).includes(l.split('|')[0]!));
  const controlRowCounts: Record<string, number> = {};
  for (const line of controlRows) {
    const [table, count] = line.split('|');
    if (table) controlRowCounts[table] = Number(count ?? '0');
  }

  return {
    takenAt: new Date().toISOString(),
    gbrainVersion: pin,
    configKeys,
    pages,
    sources,
    controlRowCounts,
    filePlane,
    parts: [
      hashPart('pin', '.env GBRAIN_VERSION', [pin]),
      hashPart('sources', 'gbrain-ops local admin; sources status --json enumeration; ' +
        'no federated-read qualifier applies to this scope', sourcesStatus),
      hashPart('repos', 'every directory under BRAIN_REPOS; HEAD^{tree} plus tracked-file count', repos),
      hashPart('configKeys', 'GBRAIN_HOME/.gbrain/config.json; dotted key names only', configKeys),
      hashPart('controlRows', `control public tables, excluding ${UNCOUNTED_TABLES.join(',')}`, controlRows),
      filePlane,
    ],
  };
}

export type DigestComparison = {
  equal: boolean;
  differing: { part: string; a: string; b: string; aItems: number; bItems: number }[];
  onlyInA: string[];
  onlyInB: string[];
};

/** Per-part differences, never a bare boolean: a failure has to say WHAT moved. */
export function compareDigests(a: StateDigest, b: StateDigest): DigestComparison {
  const byName = (d: StateDigest) => new Map(d.parts.map((p) => [p.name, p]));
  const [ma, mb] = [byName(a), byName(b)];
  const differing: DigestComparison['differing'] = [];
  for (const [name, pa] of ma) {
    const pb = mb.get(name);
    if (!pb || pa.sha256 === pb.sha256) continue;
    differing.push({ part: name, a: pa.sha256, b: pb.sha256, aItems: pa.items, bItems: pb.items });
  }
  const onlyInA = [...ma.keys()].filter((n) => !mb.has(n)).sort();
  const onlyInB = [...mb.keys()].filter((n) => !ma.has(n)).sort();
  return {
    equal: differing.length === 0 && onlyInA.length === 0 && onlyInB.length === 0,
    differing: differing.sort((x, y) => x.part.localeCompare(y.part)),
    onlyInA, onlyInB,
  };
}

export type DoctorParity = {
  regressed: DoctorCheckSummary[];
  newChecks: DoctorCheckSummary[];
  resolved: DoctorCheckSummary[];
  schemaVersionOk: boolean;
  status: string;
  healthScore: number;
};

/**
 * D5: per-check parity, not the exit code (`warnings` exits 0, U7), not
 * `blockers` (it does not exist, L4), not `health_score` (it moves when
 * upstream adds a check).
 */
export function compareDoctor(baseline: DoctorBaseline, after: DoctorBaseline): DoctorParity {
  const before = new Map(baseline.checks.map((c) => [c.name, c]));
  const now = new Map(after.checks.map((c) => [c.name, c]));
  const schema = now.get('schema_version');
  return {
    regressed: after.checks.filter((c) => before.get(c.name)?.status === 'ok' && c.status !== 'ok'),
    newChecks: after.checks.filter((c) => !before.has(c.name)),
    resolved: after.checks.filter((c) => {
      const was = before.get(c.name);
      return was !== undefined && was.status !== 'ok' && c.status === 'ok';
    }),
    // A check that is not there did not pass (honesty rule 1).
    schemaVersionOk: schema?.status === 'ok',
    status: after.status,
    healthScore: after.healthScore,
  };
}

export class RollbackRefusal extends Error {
  constructor(readonly code: 'NO_MANIFEST' | 'MANIFEST_VERIFY_FAILED', message: string) {
    super(`${code}: ${message}`);
    this.name = 'RollbackRefusal';
  }
}

export type RollbackReport = {
  runId: string; pin: string; restored: string[];
  // D4 / honesty rule 5: there is no down-migration anywhere upstream (U8), so
  // snapshot restore is the only thing rollback could mean. Both fields are
  // stated, not implied.
  method: 'snapshot-restore';
  ranUpstreamDownMigrations: false;
  digest: StateDigest | null; pinVerified: boolean; ok: boolean;
};

/**
 * The minimal surface `rollback` uses. Deliberately structural rather than
 * `typeof dockerVolumeDriver` / `typeof realQuiesce`: `dockerVolumeDriver.verify`
 * returns `boolean` and `realQuiesce` returns `QuiesceEvidence`, which the Task
 * 12 test fixtures intentionally do not reproduce — they only need the methods
 * `rollback` actually calls to exist.
 */
export type RollbackDeps = {
  driver: { restore(ctx: SnapshotContext, manifest: SnapshotManifest): Promise<void> };
  quiesce(ctx: UpgradeContext): Promise<unknown>;
  resume(ctx: UpgradeContext): Promise<void>;
  /** Build the images at `version` BEFORE recreate, so the running binary
   *  moves back with the pin. The swap rebuilt the un-version-tagged
   *  `control-plane:dev` image at the new pin; without an explicit rebuild at
   *  the old pin, `.env` says 0.50.0.0 while the container still runs
   *  0.50.5.0 and health's pin cross-check is false (honesty rule 9). The
   *  version is passed explicitly because relying on the ambient
   *  GBRAIN_VERSION value is exactly how this went wrong. */
  buildImages(ctx: UpgradeContext, version: string): Promise<void>;
  recreate(ctx: UpgradeContext, services: readonly string[]): Promise<void>;
  verifyRuntimePin(ctx: UpgradeContext, version: string): Promise<boolean>;
  stateDigest(ctx: UpgradeContext): Promise<StateDigest>;
};

/**
 * A rollback that hangs must fail loudly instead of burning a core forever
 * (BUG 1 of Task 17). Every awaited step is raced against the remaining
 * budget, so an unbounded `await` — a stuck docker call, a relay that never
 * answers — throws with the step's name. A *synchronous* spin cannot be
 * preempted by a timer in the same thread; that is why the circular import
 * that caused the observed spin is removed structurally, not merely timed out.
 */
export const ROLLBACK_BUDGET_MS = 30 * 60_000;

/**
 * One operation (D4, honesty rule 5). Reads the journal and manifest from DISK,
 * because the case this exists for is the control plane never coming back.
 *
 * Verification comes FIRST and nothing is touched until it passes: restoring an
 * artifact whose checksum does not match would overwrite a half-upgraded stack
 * with garbage, which is strictly worse than the state it was called to fix.
 */
export async function rollback(
  ctx: UpgradeContext, runId: string, deps: Partial<RollbackDeps> = {},
): Promise<RollbackReport> {
  const d: RollbackDeps = {
    driver: dockerVolumeDriver,
    quiesce: realQuiesce,
    resume: realResume,
    buildImages: async () => { throw new Error('buildImages dependency is required'); },
    recreate: async () => { throw new Error('recreate dependency is required'); },
    verifyRuntimePin: async () => true,
    stateDigest,
    ...deps,
  };

  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(await readFile(join(ctx.upgradeDir, 'manifest.json'), 'utf8')) as SnapshotManifest;
  } catch {
    throw new RollbackRefusal('NO_MANIFEST', `no snapshot manifest for run ${runId}`);
  }
  const verified = await verifyManifest(manifest, ctx.upgradeDir);
  if (!verified.ok) {
    throw new RollbackRefusal(
      'MANIFEST_VERIFY_FAILED',
      `${verified.mismatches.join(', ')} — refusing to restore unverified artifacts over the stack`,
    );
  }

  // The driver takes a SnapshotContext, not the whole UpgradeContext: the
  // artifact set and output dir are the driver's inputs, so project them here.
  const snapCtx: SnapshotContext = {
    runId: ctx.runId,
    volumes: snapshotVolumes(),
    databases: SNAPSHOT_DATABASES,
    outDir: ctx.upgradeDir,
    compose: ctx.compose,
  };

  // Bounded: an unbounded await fails loudly with the step's name instead of
  // pinning the process. The deadline is shared across every step.
  const deadline = Date.now() + ROLLBACK_BUDGET_MS;
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`rollback exceeded its ${ROLLBACK_BUDGET_MS}ms budget before '${name}'`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`rollback step '${name}' exceeded its ${remaining}ms budget`)),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  await step('quiesce', () => d.quiesce(ctx));
  await step('restore', () => d.driver.restore(snapCtx, manifest));

  // The pin moves back before the images are recreated, so compose reads the
  // old value; D8 removed the ${GBRAIN_VERSION:-0.50.0.0} fallbacks precisely so
  // a missed --env-file fails loudly instead of silently rebuilding the new tag.
  await step('writePin', async () => { await writePin(ctx.envPath, manifest.fromVersion); });
  // Rebuild at the OLD pin before recreating: the control-plane image tag does
  // not encode the gbrain version, so `up` alone would leave the running
  // binary at the new pin while `.env` claims the old one (honesty rule 9).
  await step('buildImages', () => d.buildImages(ctx, manifest.fromVersion));
  await step('recreate', () => d.recreate(ctx, ['gbrain-ops', 'gbrain-serve', 'gbrain-worker', 'control-plane']));
  await step('resume', () => d.resume(ctx));

  const pinVerified = await step('verifyRuntimePin', () => d.verifyRuntimePin(ctx, manifest.fromVersion));
  const digest = await step('stateDigest', () => d.stateDigest(ctx));
  return {
    runId, pin: manifest.fromVersion,
    restored: manifest.artifacts.map((a) => a.name),
    method: 'snapshot-restore', ranUpstreamDownMigrations: false,
    digest, pinVerified, ok: pinVerified,
  };
}
