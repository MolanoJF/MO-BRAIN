import { OPERATIONS } from '../contracts/registry.ts';

/**
 * The commands a schedule may run, a strict subset of the RPC allowlist.
 *
 * `scope` is honesty rule 2: not everything can be fenced to a Space. `doctor`
 * reads the whole brain, so a schedule that runs it needs an admin-or-better
 * Connection and a banner that says so.
 *
 * `fenced` is honesty rule 1 in code: these params are computed by the
 * scheduler from the Connection's write Space and may never be supplied by a
 * caller. The fence is OURS — V1 established that these commands are absent
 * from gbrain's MCP operation registry, so they run as gbrain-ops's local admin
 * identity no matter which Connection owns the schedule.
 */
export type CommandScope = 'source' | 'brain-wide';

export type TunableSpec =
  | { kind: 'flag' }
  | { kind: 'enum'; values: string[] }
  | { kind: 'int'; min: number; max: number };

export type SchedulerCommand = {
  id: string;
  /** A key of OPERATIONS. */
  operation: string;
  scope: CommandScope;
  fenced: string[];
  tunable: Record<string, TunableSpec>;
  json: boolean;
  /**
   * How much this run changed, for report_policy 'on_change_or_failure'.
   * null means UNKNOWN, and unknown is never treated as "nothing happened" —
   * the caller writes the report.
   */
  changeCount(json: unknown): number | null;
};

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * `autopilot --status --json`'s AutopilotStatusReport, OBSERVED from the
 * pinned gbrain (docs/archive/autopilot-status-findings.md): exactly these keys, and
 * on a Mo-brain stack `installed:false, state:'not_installed'`.
 */
const AUTOPILOT_STATUS_KEYS = [
  'installed', 'install_target', 'state', 'disabled_reason', 'paused_reason',
  'heartbeat_age_seconds', 'stale_after_seconds', 'last_log',
];
const AUTOPILOT_STATES = ['not_installed', 'disabled', 'paused', 'never_run', 'stale', 'fresh'];

/**
 * The tripwire's evidence, or null when it cannot be read. "Not installed" is
 * believed only when the whole report agrees with itself: a key-set drift or
 * an `installed:false` next to a live state is unknown, never a pass — a gate
 * that cannot read its evidence must not pass vacuously (Slice 0 V6).
 */
export function readAutopilotReport(payload: unknown): { installed: boolean; state: string } | null {
  const o = obj(payload);
  if (!o) return null;
  if (Object.keys(o).length !== AUTOPILOT_STATUS_KEYS.length) return null;
  if (!AUTOPILOT_STATUS_KEYS.every((k) => k in o)) return null;
  if (typeof o.installed !== 'boolean' || typeof o.state !== 'string') return null;
  if (!AUTOPILOT_STATES.includes(o.state)) return null;
  if (!o.installed && o.state !== 'not_installed') return null;
  return { installed: o.installed, state: o.state };
}

/**
 * `dream --json`'s CycleReport tally, OBSERVED from the pinned gbrain (Task 5
 * Step 5): `gbrain dream --source <id> --dry-run --json` exits 0, prints one
 * prose line, then
 * `{ schema_version, timestamp, duration_ms, status, brain_dir, phases[], totals{} }`
 * — 23 phases and this exact `totals` key set. `status` reads `partial`
 * even on a clean dry run (excluded phases, not a failure), so status is NOT a
 * change signal; the tally is.
 */
const DREAM_TOTALS_KEYS = [
  'lint_fixes', 'backlinks_added', 'pages_synced', 'pages_extracted', 'pages_embedded',
  'orphans_found', 'transcripts_processed', 'synth_pages_written', 'patterns_written',
  'pages_emotional_weight_recomputed', 'edges_resolved', 'edges_ambiguous',
  'purged_sources_count', 'purged_pages_count', 'facts_consolidated',
  'consolidate_takes_written', 'phantoms_redirected', 'phantoms_ambiguous',
  'phantoms_skipped_drift',
];

export const SCHEDULER_COMMANDS: Record<string, SchedulerCommand> = {
  sync: {
    id: 'sync', operation: 'sync', scope: 'source',
    fenced: ['source'], tunable: {}, json: true,
    // src/core/sync-embed-backfill.ts buildSingleSyncJsonEnvelope:
    // { schema_version, source_id, sync_status, added, modified, deleted,
    //   chunks_created, embedded, embed_backfill? }
    changeCount(payload) {
      const o = obj(payload);
      if (!o) return null;
      const parts = [num(o.added), num(o.modified), num(o.deleted)];
      if (parts.every((p) => p === null)) return null;
      return parts.reduce<number>((a, p) => a + (p ?? 0), 0);
    },
  },

  embed: {
    id: 'embed', operation: 'embed', scope: 'source',
    fenced: ['source'], tunable: { stale: { kind: 'flag' } }, json: true,
    // src/commands/embed.ts EmbedResult: { embedded, skipped, would_embed,
    // total_chunks, healed_splits? }
    changeCount(payload) {
      const o = obj(payload);
      if (!o) return null;
      return num(o.embedded);
    },
  },

  dream: {
    id: 'dream', operation: 'dream', scope: 'source',
    fenced: ['source'],
    tunable: {
      phase: {
        kind: 'enum',
        values: ['lint', 'backlinks', 'extract', 'sync', 'embed', 'synthesize'],
      },
      maxUsd: { kind: 'int', min: 1, max: 100 },
      yes: { kind: 'flag' },
    },
    json: true,
    /**
     * The CycleReport `totals` tally — what the run actually did. The plan's
     * draft counted `phases.length`, which is not a change count at all: the
     * observed envelope carries 23 phases (4 ok / 18 skipped / 1 warn on a dry
     * run of a single source), so it would report "changed" forever and turn
     * `on_change_or_failure` into `always`.
     *
     * Unrecognized shapes return null. That direction is deliberate: a version
     * bump that adds or removes a tally key makes the sum INCOMPLETE, and an
     * incomplete sum can read 0 while pages were written — a silently dropped
     * report. Unknown instead means "write the report".
     */
    changeCount(payload) {
      const o = obj(payload);
      if (!o) return null;
      if (!Array.isArray(o.phases)) return null;
      const totals = obj(o.totals);
      if (!totals) return null;
      if (Object.keys(totals).length !== DREAM_TOTALS_KEYS.length) return null;
      if (!DREAM_TOTALS_KEYS.every((k) => k in totals)) return null;
      const values = DREAM_TOTALS_KEYS.map((k) => num(totals[k]));
      // A tally we cannot read every number out of is UNKNOWN, not zero: a
      // counter we silently treat as 0 can hide a real write.
      if (values.some((v) => v === null)) return null;
      return values.reduce<number>((a, v) => a + (v ?? 0), 0);
    },
  },

  /**
   * Brain-wide. `gbrain doctor` has no source scope, so a schedule that runs it
   * reads everything. Honesty rule 2: admin-or-better Connection plus a banner.
   */
  doctor: {
    id: 'doctor', operation: 'doctor', scope: 'brain-wide',
    fenced: [],
    tunable: {
      remediate: { kind: 'flag' },
      yes: { kind: 'flag' },
      maxUsd: { kind: 'int', min: 1, max: 100 },
      targetScore: { kind: 'int', min: 1, max: 100 },
    },
    json: true,
    /**
     * Slice 0 findings V6: DoctorReport at this pin is
     * { schema_version, status, health_score, brain_checks_score,
     *   category_scores, checks[], top_issues?, engine?, db_url_source? }
     * There is NO top-level blockers array. Walk checks[] instead — a gate that
     * reads report.blockers passes vacuously, which is exactly the bug Slice 0
     * found in lifecycle.contract.test.ts.
     */
    changeCount(payload) {
      const o = obj(payload);
      if (!o) return null;
      const checks = o.checks;
      if (!Array.isArray(checks)) return null;
      return checks.filter((c) => obj(c)?.status !== 'ok').length;
    },
  },

  /**
   * A TRIPWIRE, not a health gate. Mo-brain never installs gbrain's autopilot
   * (this scheduler replaces it), so the only healthy answer is
   * not_installed, and ANY install — even a `fresh` one that exits 0 — is a
   * second scheduler on this brain. Brain-wide because the probe reads the
   * shared GBRAIN_HOME, which no Space fences.
   */
  'autopilot-status': {
    id: 'autopilot-status', operation: 'autopilot.status', scope: 'brain-wide',
    fenced: [], tunable: {}, json: true,
    changeCount(payload) {
      const r = readAutopilotReport(payload);
      if (!r) return null;
      return r.installed ? 1 : 0;
    },
  },

  'sources-push': {
    id: 'sources-push', operation: 'sources.push', scope: 'source',
    // The source id is a POSITIONAL on this command, not --source.
    fenced: ['id'],
    tunable: { branch: { kind: 'enum', values: ['main', 'master'] }, allowUnverifiedRemote: { kind: 'flag' } },
    json: true,
    // WorkspacePushResult: { ok, status, reason?, committed?, ahead?, ... }
    changeCount(payload) {
      const o = obj(payload);
      if (!o) return null;
      if (typeof o.status !== 'string') return null;
      return o.status === 'pushed' && o.committed === true ? 1 : 0;
    },
  },
};

export function validateParams(
  command: SchedulerCommand, params: Record<string, unknown>,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    if (command.fenced.includes(key)) {
      throw new Error(`param ${key} is fenced for ${command.id} — it is derived from the Connection`);
    }
    const spec = command.tunable[key];
    if (!spec) throw new Error(`unknown param ${key} for ${command.id}`);

    if (spec.kind === 'flag') {
      if (value !== true) throw new Error(`param ${key} must be boolean true`);
      out[key] = true;
      continue;
    }
    if (spec.kind === 'enum') {
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        throw new Error(`param ${key} must be one of ${spec.values.join(', ')}`);
      }
      out[key] = value;
      continue;
    }
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
      throw new Error(`param ${key} must be an integer in [${spec.min}, ${spec.max}]`);
    }
    out[key] = String(n);
  }
  return out;
}

/** Apply the Connection fence. Runs AFTER validateParams, never instead of it. */
export function fenceParams(
  command: SchedulerCommand,
  validated: Record<string, string | boolean>,
  writeSourceId: string,
): Record<string, string | boolean> {
  const out = { ...validated };
  for (const f of command.fenced) out[f] = writeSourceId;
  return out;
}

/** Fail fast at import time rather than at 3am: the allowlist must be coherent. */
for (const cmd of Object.values(SCHEDULER_COMMANDS)) {
  const spec = OPERATIONS[cmd.operation];
  if (!spec) throw new Error(`scheduler command ${cmd.id} names an unknown operation ${cmd.operation}`);
  const known = new Set(spec.params.map((p) => p.name));
  for (const name of [...cmd.fenced, ...Object.keys(cmd.tunable)]) {
    if (!known.has(name)) throw new Error(`scheduler command ${cmd.id} names unknown param ${name}`);
  }
  if (cmd.json && !spec.supportsJson) {
    throw new Error(`scheduler command ${cmd.id} wants --json but ${cmd.operation} does not support it`);
  }
}
