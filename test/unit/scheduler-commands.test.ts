import { test, expect, describe } from 'bun:test';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import {
  SCHEDULER_COMMANDS, fenceParams, validateParams,
} from '../../src/scheduler/commands.ts';

describe('the allowlist', () => {
  test('every scheduler command maps to a real allowlisted operation', () => {
    for (const cmd of Object.values(SCHEDULER_COMMANDS)) {
      expect(OPERATIONS[cmd.operation]).toBeDefined();
    }
  });

  test('every fenced and tunable param exists on its operation spec', () => {
    for (const cmd of Object.values(SCHEDULER_COMMANDS)) {
      const known = new Set(OPERATIONS[cmd.operation]!.params.map((p) => p.name));
      for (const f of cmd.fenced) expect(known.has(f)).toBe(true);
      for (const t of Object.keys(cmd.tunable)) expect(known.has(t)).toBe(true);
    }
  });

  test('fenced and tunable never overlap — a fence a user can set is not a fence', () => {
    for (const cmd of Object.values(SCHEDULER_COMMANDS)) {
      for (const f of cmd.fenced) expect(cmd.tunable[f]).toBeUndefined();
    }
  });

  test('a command that declares json:true uses an operation that supports it', () => {
    for (const cmd of Object.values(SCHEDULER_COMMANDS)) {
      if (cmd.json) expect(OPERATIONS[cmd.operation]!.supportsJson).toBe(true);
    }
  });

  test('doctor is the only brain-wide command, and it is marked as such', () => {
    const brainWide = Object.values(SCHEDULER_COMMANDS)
      .filter((c) => c.scope === 'brain-wide').map((c) => c.id);
    expect(brainWide).toEqual(['doctor']);
  });

  test('check-update is NOT schedulable — it belongs to Slice 3.5', () => {
    expect(SCHEDULER_COMMANDS['check-update']).toBeUndefined();
    expect(Object.values(SCHEDULER_COMMANDS).some((c) => c.operation === 'checkUpdate')).toBe(false);
  });
});

describe('param validation', () => {
  test('an unknown param is rejected, not ignored', () => {
    expect(() => validateParams(SCHEDULER_COMMANDS.sync!, { nonsense: 'x' }))
      .toThrow(/unknown param/);
  });

  test('a FENCED param supplied by the caller is rejected outright', () => {
    expect(() => validateParams(SCHEDULER_COMMANDS.sync!, { source: 'someone-elses-space' }))
      .toThrow(/fenced/);
    expect(() => validateParams(SCHEDULER_COMMANDS.embed!, { source: 'other' }))
      .toThrow(/fenced/);
  });

  test('an enum value outside the allowed set is rejected', () => {
    expect(() => validateParams(SCHEDULER_COMMANDS.dream!, { phase: 'rm -rf' }))
      .toThrow(/phase/);
    expect(validateParams(SCHEDULER_COMMANDS.dream!, { phase: 'lint' })).toEqual({ phase: 'lint' });
  });

  test('an int outside its bounds is rejected; inside, it stringifies', () => {
    expect(() => validateParams(SCHEDULER_COMMANDS.doctor!, { maxUsd: 500 })).toThrow(/maxUsd/);
    expect(() => validateParams(SCHEDULER_COMMANDS.doctor!, { maxUsd: -1 })).toThrow(/maxUsd/);
    expect(validateParams(SCHEDULER_COMMANDS.doctor!, { maxUsd: 5 })).toEqual({ maxUsd: '5' });
  });

  test('a flag must be boolean true, not a truthy string', () => {
    expect(() => validateParams(SCHEDULER_COMMANDS.embed!, { stale: 'yes' })).toThrow(/stale/);
    expect(validateParams(SCHEDULER_COMMANDS.embed!, { stale: true })).toEqual({ stale: true });
  });
});

describe('the scope fence', () => {
  test('a source-scoped command gets --source from the Connection, always', () => {
    const fenced = fenceParams(SCHEDULER_COMMANDS.sync!, {}, 'shared');
    expect(fenced).toEqual({ source: 'shared' });
    expect(buildArgv(OPERATIONS.sync!, fenced, { json: true }))
      .toEqual(['sync', '--source', 'shared', '--json']);
  });

  test('the fence overrides nothing a caller smuggled in, because validate ran first', () => {
    const validated = validateParams(SCHEDULER_COMMANDS.embed!, { stale: true });
    const fenced = fenceParams(SCHEDULER_COMMANDS.embed!, validated, 'customers');
    expect(fenced).toEqual({ stale: true, source: 'customers' });
  });

  test('a brain-wide command gets NO source fence — the UI must say so', () => {
    expect(fenceParams(SCHEDULER_COMMANDS.doctor!, { remediate: true, yes: true, maxUsd: '5' }, 'shared'))
      .toEqual({ remediate: true, yes: true, maxUsd: '5' });
  });

  test('sources.push fences the POSITIONAL id, not --source', () => {
    const fenced = fenceParams(SCHEDULER_COMMANDS['sources-push']!, {}, 'shared');
    expect(fenced).toEqual({ id: 'shared' });
    expect(buildArgv(OPERATIONS['sources.push']!, fenced, { json: true }))
      .toEqual(['sources', 'push', 'shared', '--json']);
  });
});

describe('change counting drives report_policy on_change_or_failure', () => {
  test('sync reports its own added/modified/deleted counts', () => {
    // Upstream shape: src/core/sync-embed-backfill.ts buildSingleSyncJsonEnvelope
    const payload = {
      schema_version: 1, source_id: 'shared', sync_status: 'synced',
      added: 2, modified: 1, deleted: 0, chunks_created: 7, embedded: 7,
    };
    expect(SCHEDULER_COMMANDS.sync!.changeCount(payload)).toBe(3);
    expect(SCHEDULER_COMMANDS.sync!.changeCount({ ...payload, added: 0, modified: 0 })).toBe(0);
  });

  test('embed reports its embedded count', () => {
    expect(SCHEDULER_COMMANDS.embed!.changeCount({ embedded: 4, skipped: 0 })).toBe(4);
    expect(SCHEDULER_COMMANDS.embed!.changeCount({ embedded: 0, skipped: 12 })).toBe(0);
  });

  test('an UNREADABLE payload returns null, and null must never mean "no change"', () => {
    for (const cmd of Object.values(SCHEDULER_COMMANDS)) {
      expect(cmd.changeCount(null)).toBeNull();
      expect(cmd.changeCount('not json')).toBeNull();
      expect(cmd.changeCount({ totally: 'different' })).toBeNull();
    }
  });

  test('doctor never reads report.blockers — that key does not exist at this pin', () => {
    // Slice 0 findings V6: DoctorReport has status/health_score/checks[]/top_issues,
    // and NO top-level blockers array. A gate that reads it passes vacuously.
    const src = SCHEDULER_COMMANDS.doctor!.changeCount.toString();
    expect(src).not.toContain('blockers');
    const report = {
      schema_version: 2, status: 'warnings', health_score: 70,
      checks: [{ id: 'a', status: 'ok' }, { id: 'b', status: 'warn' }, { id: 'c', status: 'fail' }],
    };
    expect(SCHEDULER_COMMANDS.doctor!.changeCount(report)).toBe(2); // non-ok checks
  });
});

/**
 * Tightened at Task 10 against the REAL payload captured in Task 5 Step 5
 * (`docs/slice-3-findings.md`): the plan's drafts counted `phases.length`, which
 * is not a change count — the observed envelope always carries its phase list.
 */
describe('dream change counting, against the observed CycleReport', () => {
  // Observed: `gbrain dream --source slice3-probe --dry-run --json` exits 0,
  // prints ONE prose line, then an envelope with these top-level keys and this
  // 19-key `totals` tally. `status` is 'partial' even on a clean dry run
  // (excluded phases, not a failure), so status is not a change signal.
  const totals = {
    lint_fixes: 0, backlinks_added: 0, pages_synced: 0, pages_extracted: 0,
    pages_embedded: 0, orphans_found: 0, transcripts_processed: 0,
    synth_pages_written: 0, patterns_written: 0,
    pages_emotional_weight_recomputed: 0, edges_resolved: 0, edges_ambiguous: 0,
    purged_sources_count: 0, purged_pages_count: 0, facts_consolidated: 0,
    consolidate_takes_written: 0, phantoms_redirected: 0, phantoms_ambiguous: 0,
    phantoms_skipped_drift: 0,
  };

  // Observed phase distribution: 4 ok, 1 warn (lint), 18 skipped, all carrying
  // { phase, status, duration_ms, summary, details }. The skipped item below is
  // verbatim; the other phase identifiers are not load-bearing for the extractor.
  const skipped = {
    phase: 'synthesize', status: 'skipped', duration_ms: 0,
    summary: 'excluded from implicit non-default source cycle (mixed scope)',
    details: {
      reason: 'excluded_from_implicit_source_cycle',
      source_id: 'slice3-probe',
      phase_scope: 'mixed',
    },
  };
  const phases = [
    ...Array.from({ length: 4 }, () => ({ phase: 'lint', status: 'ok', duration_ms: 0, summary: '', details: {} })),
    { phase: 'lint', status: 'warn', duration_ms: 0, summary: '', details: {} },
    ...Array.from({ length: 18 }, () => ({ ...skipped, details: { ...skipped.details } })),
  ];
  const envelope = {
    schema_version: 1, timestamp: '2026-09-15T00:00:00.000Z', duration_ms: 4210,
    status: 'partial', brain_dir: '/srv/brain', phases, totals,
  };

  test('23 phases are not 23 changes: the tally is the count', () => {
    expect(SCHEDULER_COMMANDS.dream!.changeCount(envelope)).toBe(0);
    // 'partial' + exit 0 is the dry-run shape and must not itself count.
    expect(SCHEDULER_COMMANDS.dream!.changeCount({
      ...envelope, totals: { ...totals, pages_synced: 3, backlinks_added: 5 },
    })).toBe(8);
  });

  test('a drifted or unreadable tally is UNKNOWN, never zero', () => {
    // phases[] gone entirely
    expect(SCHEDULER_COMMANDS.dream!.changeCount({ ...envelope, phases: undefined })).toBeNull();
    // totals gone entirely
    expect(SCHEDULER_COMMANDS.dream!.changeCount({ ...envelope, totals: undefined })).toBeNull();
    // a version bump drops a counter: the sum would be incomplete, so fail safe
    const { phantoms_skipped_drift: dropped, ...short } = totals;
    expect(dropped).toBe(0);
    expect(SCHEDULER_COMMANDS.dream!.changeCount({ ...envelope, totals: short })).toBeNull();
    // a version bump adds one
    expect(SCHEDULER_COMMANDS.dream!.changeCount({
      ...envelope, totals: { ...totals, new_counter: 0 },
    })).toBeNull();
    // a present counter we cannot read as a number still hides a possible write
    expect(SCHEDULER_COMMANDS.dream!.changeCount({
      ...envelope, totals: { ...totals, pages_synced: 'lots' },
    })).toBeNull();
  });
});
