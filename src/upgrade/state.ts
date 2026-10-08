import type { UpgradeRunState } from './types.ts';

export type { UpgradeRunState };

/**
 * The durable slice of a journal line that `resumeFrom` classifies from (D2).
 *
 * This is deliberately structural rather than reusing `UpgradeEvent` from
 * `./types.ts`: Task 4 owns that type with the canonical shape
 * `{ seq, at, step, level, message, data? }`, which carries no run state. The
 * journal here records a transition's `state`, so a dead run can be classified
 * from `journal.ndjson` alone. `state` is `string`, not `UpgradeRunState`, on
 * purpose — the file on disk is untrusted and may name a state a newer build
 * wrote, which `resumeFrom` reports as `unknown` rather than trusting.
 *
 * `writers: 'held'` is journal data on `gated_ok`, not a new run state. Absent
 * means the gate passed and the closing step is unfinished — still a rollback.
 */
export type JournalStateRecord = { seq: number; state: string; writers?: 'held' };

/** Printed by `run` and named by `resumeFrom` when writers were held on purpose. */
export const RESUME_WRITERS_COMMAND = 'bun run scripts/upgrade.ts resume-writers --run';

/**
 * The legal edges, and only the legal edges. Keys are exactly the CHECK list in
 * src/control/db/schema.ts, and a unit test compares the two mechanically
 * rather than trusting that both were edited together (L9).
 *
 * Two shapes are load-bearing:
 *   - `failed` is reachable only BEFORE the swap. Up to that point the only
 *     mutation is stopped services, which resume() puts back, so there is
 *     nothing to restore. It is terminal and has no edge to rolling_back.
 *   - From `swapped` onward the only failure edge is `rolling_back`. The pin on
 *     disk and the running images have already moved; the honest response to
 *     any failure there is the snapshot, not a status change.
 */
export const TRANSITIONS: Readonly<Record<UpgradeRunState, readonly UpgradeRunState[]>> = {
  planned: ['preflight_ok', 'failed'],
  preflight_ok: ['quiesced', 'failed'],
  quiesced: ['snapshot_taken', 'failed'],
  snapshot_taken: ['swapped', 'failed'],
  swapped: ['migrated', 'rolling_back'],
  migrated: ['playbooks_applied', 'rolling_back'],
  playbooks_applied: ['gated_ok', 'rolling_back'],
  gated_ok: ['completed', 'rolling_back'],
  rolling_back: ['rolled_back', 'rollback_failed'],
  completed: [],
  failed: [],
  rolled_back: [],
  rollback_failed: [],
};

const ON_SUCCESS: Readonly<Record<UpgradeRunState, UpgradeRunState | null>> = {
  planned: 'preflight_ok',
  preflight_ok: 'quiesced',
  quiesced: 'snapshot_taken',
  snapshot_taken: 'swapped',
  swapped: 'migrated',
  migrated: 'playbooks_applied',
  playbooks_applied: 'gated_ok',
  gated_ok: 'completed',
  rolling_back: 'rolled_back',
  completed: null, failed: null, rolled_back: null, rollback_failed: null,
};

const ON_FAILURE: Readonly<Record<UpgradeRunState, UpgradeRunState | null>> = {
  planned: 'failed',
  preflight_ok: 'failed',
  quiesced: 'failed',
  snapshot_taken: 'failed',
  swapped: 'rolling_back',
  migrated: 'rolling_back',
  playbooks_applied: 'rolling_back',
  gated_ok: 'rolling_back',
  rolling_back: 'rollback_failed',
  completed: null, failed: null, rolled_back: null, rollback_failed: null,
};

/**
 * States a dead run may pick up from. Everything here mutated nothing that a
 * plain `resume` (Task 6) cannot undo — except `rolling_back`, which is here
 * because a restore from a verified manifest is idempotent: re-running it
 * re-restores the same four artifacts over whatever the dead attempt left.
 */
export const SAFE_TO_RESUME: readonly UpgradeRunState[] = [
  'planned', 'preflight_ok', 'quiesced', 'snapshot_taken', 'rolling_back',
];

/** Post-swap. The pin and the images moved; the snapshot is the way back. */
export const ROLLBACK_REQUIRED: readonly UpgradeRunState[] = [
  'swapped', 'migrated', 'playbooks_applied', 'gated_ok',
];

const ROLLBACK_REASONS: Readonly<Record<string, string>> = {
  swapped:
    'the pin was moved and the new images are live, but no migration step has completed and no ' +
    'published contract reports the running schema version (U6/G3) — the tool will not infer that ' +
    'this pairing is safe, so the snapshot is the way forward',
  migrated:
    'apply-migrations and post-upgrade ran but the playbook steps did not, so this install is at ' +
    'the new schema with an unknown amount of its playbook applied',
  playbooks_applied:
    'the playbooks ran but the doctor parity gate never returned a verdict, so nothing has ' +
    'established that this upgrade is healthy',
  gated_ok:
    'the gate passed but the run never reached completed, so the last step — resuming the stack ' +
    'and closing the run — is in an unknown state',
};

const HOLD_WRITERS_REASON =
  'the schema jump succeeded and writers are down on purpose; the next command is ' +
  `${RESUME_WRITERS_COMMAND} <runId>, not rollback. ` +
  'Rollback remains the way back if the admin rejects the jump itself.';

export function isTerminal(state: UpgradeRunState): boolean {
  return TRANSITIONS[state].length === 0;
}

export function canTransition(from: UpgradeRunState, to: UpgradeRunState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextState(current: UpgradeRunState, outcome: 'ok' | 'failed'): UpgradeRunState {
  const next = (outcome === 'ok' ? ON_SUCCESS : ON_FAILURE)[current];
  if (!next) throw new Error(`no transition from terminal state '${current}'`);
  return next;
}

export type ResumeDecision =
  | { kind: 'resume'; from: UpgradeRunState; next: UpgradeRunState }
  | { kind: 'rollback-required'; from: UpgradeRunState; reason: string }
  | { kind: 'hold-writers'; from: 'gated_ok'; reason: string }
  | { kind: 'terminal'; from: UpgradeRunState; needsAttention: boolean }
  | { kind: 'unknown'; reason: string };

/**
 * Classify a run from its journal alone (D2). The control plane may never have
 * seen this run: it is stopped for most of an upgrade, and for a run that died
 * during the swap it was stopped for all of it.
 *
 * The highest `seq` wins. A half-written trailing line never reaches here —
 * Task 4's readJournal drops it — so "truncated" simply means the last complete
 * event is the answer, which is the correct conservative reading: a state that
 * was not durably recorded did not happen.
 */
export function resumeFrom(journal: readonly JournalStateRecord[]): ResumeDecision {
  if (journal.length === 0) {
    return { kind: 'unknown', reason: 'the journal is empty: no run state was ever durably recorded' };
  }
  const last = [...journal].sort((a, b) => a.seq - b.seq).at(-1)!;
  const state = last.state as UpgradeRunState;

  if (!(state in TRANSITIONS)) {
    return {
      kind: 'unknown',
      reason: `the journal records state '${String(last.state)}', which this build does not know; ` +
        'refusing to guess what a newer or corrupted run was doing',
    };
  }
  if (isTerminal(state)) {
    return {
      kind: 'terminal', from: state,
      needsAttention: state === 'failed' || state === 'rollback_failed',
    };
  }
  // A held gate is an intentional pause, not an unfinished close. Only this
  // pairing: a gated_ok record without `writers` stays rollback-required.
  if (state === 'gated_ok' && last.writers === 'held') {
    return { kind: 'hold-writers', from: 'gated_ok', reason: HOLD_WRITERS_REASON };
  }
  if (ROLLBACK_REQUIRED.includes(state)) {
    return { kind: 'rollback-required', from: state, reason: ROLLBACK_REASONS[state]! };
  }
  return { kind: 'resume', from: state, next: nextState(state, 'ok') };
}
