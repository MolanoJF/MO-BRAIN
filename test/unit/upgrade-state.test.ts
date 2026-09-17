import { test, expect, describe } from 'bun:test';
import {
  ROLLBACK_REQUIRED, SAFE_TO_RESUME, TRANSITIONS,
  canTransition, isTerminal, nextState, resumeFrom,
  type JournalStateRecord, type UpgradeRunState,
} from '../../src/upgrade/state.ts';

const ALL = Object.keys(TRANSITIONS) as UpgradeRunState[];

/** Build a journal the way scripts/upgrade.ts appends one: monotonic seq. */
function journal(...states: UpgradeRunState[]): JournalStateRecord[] {
  return states.map((state, i) => ({
    runId: 'run-1', seq: i + 1, at: new Date(1_700_000_000_000 + i * 1000).toISOString(), state,
  }));
}

const HAPPY_PATH: UpgradeRunState[] = [
  'planned', 'preflight_ok', 'quiesced', 'snapshot_taken', 'swapped',
  'migrated', 'playbooks_applied', 'gated_ok', 'completed',
];

describe('the state set', () => {
  test('matches the CHECK constraint in the control schema, exactly', async () => {
    // L9's lesson generalised: a duplicated list is only safe when something
    // mechanical compares the copies. test/unit/control-plane-dockerfile.test.ts
    // is the precedent for statically reading one of our own files in a unit test.
    const source = await Bun.file('src/control/db/schema.ts').text();
    const clause = /upgrade_run_state_valid[\s\S]*?in \(([\s\S]*?)\)/.exec(source);
    expect(clause).not.toBeNull();
    const declared = [...clause![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    expect(ALL.slice().sort() as string[]).toEqual(declared);
  });

  test('has exactly the thirteen states and four terminals', () => {
    expect(ALL).toHaveLength(13);
    expect(ALL.filter(isTerminal).sort())
      .toEqual(['completed', 'failed', 'rollback_failed', 'rolled_back']);
  });
});

describe('canTransition', () => {
  test('the happy path walks end to end', () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i += 1) {
      expect(canTransition(HAPPY_PATH[i]!, HAPPY_PATH[i + 1]!)).toBe(true);
    }
  });

  test('every pair not in TRANSITIONS is refused — no accidental edges', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransition(from, to)).toBe(TRANSITIONS[from].includes(to));
      }
    }
  });

  test('a swapped run can never be marked failed — only rolled back', () => {
    for (const s of ['swapped', 'migrated', 'playbooks_applied', 'gated_ok'] as UpgradeRunState[]) {
      expect(canTransition(s, 'failed')).toBe(false);
      expect(canTransition(s, 'rolling_back')).toBe(true);
    }
  });

  test('failed is terminal: it never becomes a rollback after the fact', () => {
    expect(canTransition('failed', 'rolling_back')).toBe(false);
    expect(TRANSITIONS.failed).toEqual([]);
  });

  test('a completed run cannot be reopened', () => {
    for (const to of ALL) expect(canTransition('completed', to)).toBe(false);
  });

  test('no state transitions to itself', () => {
    for (const s of ALL) expect(canTransition(s, s)).toBe(false);
  });
});

describe('nextState', () => {
  test('drives the happy path one outcome at a time', () => {
    let s: UpgradeRunState = 'planned';
    const walked: UpgradeRunState[] = [s];
    while (!isTerminal(s)) { s = nextState(s, 'ok'); walked.push(s); }
    expect(walked).toEqual(HAPPY_PATH);
  });

  test('a pre-swap failure lands on failed, a post-swap failure on rolling_back', () => {
    for (const s of ['planned', 'preflight_ok', 'quiesced', 'snapshot_taken'] as UpgradeRunState[]) {
      expect(nextState(s, 'failed')).toBe('failed');
    }
    for (const s of ['swapped', 'migrated', 'playbooks_applied', 'gated_ok'] as UpgradeRunState[]) {
      expect(nextState(s, 'failed')).toBe('rolling_back');
    }
  });

  test('a failed rollback is its own terminal, not a generic failure', () => {
    expect(nextState('rolling_back', 'ok')).toBe('rolled_back');
    expect(nextState('rolling_back', 'failed')).toBe('rollback_failed');
  });

  test('every value it can return is a legal transition', () => {
    for (const s of ALL) {
      if (isTerminal(s)) continue;
      for (const outcome of ['ok', 'failed'] as const) {
        expect(canTransition(s, nextState(s, outcome))).toBe(true);
      }
    }
  });

  test('asking a terminal state for a next state throws rather than guessing', () => {
    expect(() => nextState('completed', 'ok')).toThrow('no transition from terminal state');
  });
});

describe('resumeFrom', () => {
  test('an empty journal is unknown, not resumable', () => {
    expect(resumeFrom([])).toEqual({
      kind: 'unknown',
      reason: 'the journal is empty: no run state was ever durably recorded',
    });
  });

  test('a truncated journal lands on the last DURABLE state', () => {
    // readJournal (Task 4) drops a half-written trailing line, so what reaches
    // this function is simply a shorter array. The last complete event wins.
    expect(resumeFrom(journal('planned', 'preflight_ok', 'quiesced')))
      .toEqual({ kind: 'resume', from: 'quiesced', next: 'snapshot_taken' });
  });

  test('out-of-order events are ordered by seq, not by arrival', () => {
    const events = journal('planned', 'preflight_ok', 'quiesced').reverse();
    expect(resumeFrom(events)).toMatchObject({ kind: 'resume', from: 'quiesced' });
  });

  test('every pre-swap state is resumable', () => {
    for (const s of SAFE_TO_RESUME) {
      if (s === 'rolling_back') continue;
      expect(resumeFrom(journal(s)).kind).toBe('resume');
    }
  });

  test('a run whose last event is swapped requires a rollback, not a resume', () => {
    const d = resumeFrom(journal('planned', 'preflight_ok', 'quiesced', 'snapshot_taken', 'swapped'));
    expect(d.kind).toBe('rollback-required');
    expect(d).toMatchObject({ from: 'swapped' });
    expect((d as { reason: string }).reason).toContain('no migration step has completed');
  });

  test('every post-swap state requires a rollback', () => {
    for (const s of ROLLBACK_REQUIRED) {
      expect(resumeFrom(journal(s)).kind).toBe('rollback-required');
    }
  });

  test('an interrupted rollback resumes as a rollback — restore is idempotent', () => {
    expect(resumeFrom(journal('swapped', 'rolling_back')))
      .toEqual({ kind: 'resume', from: 'rolling_back', next: 'rolled_back' });
  });

  test('terminal runs report whether they still need a human', () => {
    expect(resumeFrom(journal('completed')))
      .toEqual({ kind: 'terminal', from: 'completed', needsAttention: false });
    expect(resumeFrom(journal('rolled_back')))
      .toEqual({ kind: 'terminal', from: 'rolled_back', needsAttention: false });
    expect(resumeFrom(journal('failed')))
      .toEqual({ kind: 'terminal', from: 'failed', needsAttention: true });
    expect(resumeFrom(journal('rollback_failed')))
      .toEqual({ kind: 'terminal', from: 'rollback_failed', needsAttention: true });
  });

  test('a state this build does not know is unknown, never resumable', () => {
    const bogus = [{ runId: 'r', seq: 1, at: '2026-09-16T00:00:00.000Z', state: 'half_swapped' }];
    expect(resumeFrom(bogus).kind).toBe('unknown');
  });
});
