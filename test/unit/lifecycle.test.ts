import { test, expect, describe } from 'bun:test';
import { canAdvance, nextStep, LIFECYCLE_ORDER, SEARCH_MODES } from '../../src/control/lifecycle.ts';
import type { Lifecycle } from '../../src/control/lifecycle.ts';

describe('lifecycle', () => {
  test('advances exactly one step forward', () => {
    expect(canAdvance('uninitialized', 'provider-configured')).toBe(true);
    expect(canAdvance('provider-configured', 'mode-selected')).toBe(true);
  });

  test('refuses to skip a step', () => {
    expect(canAdvance('uninitialized', 'ready')).toBe(false);
    expect(canAdvance('uninitialized', 'schema-selected')).toBe(false);
  });

  test('refuses to move backwards', () => {
    expect(canAdvance('ready', 'sources-added')).toBe(false);
  });

  test('re-running the current step is allowed (idempotent retry)', () => {
    expect(canAdvance('provider-configured', 'provider-configured')).toBe(true);
  });

  test('nextStep walks the full order and stops at ready', () => {
    let s: Lifecycle = LIFECYCLE_ORDER[0]!;
    const seen: Lifecycle[] = [s];
    for (;;) { const n = nextStep(s); if (!n) break; s = n; seen.push(s); }
    expect(seen).toEqual([...LIFECYCLE_ORDER]);
    expect(nextStep('ready')).toBeNull();
  });
});

describe('search mode cost matrix', () => {
  // V4: this is a post-init decision and the one mandatory human choice
  // that is fully ours to render. The spread is ~25x, which is the
  // difference between a tool finance approves and one they kill.
  test('offers at least three modes with relative costs', () => {
    expect(SEARCH_MODES.length).toBeGreaterThanOrEqual(3);
    for (const m of SEARCH_MODES) {
      expect(m.relativeCost).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(20);
    }
  });

  test('the cheapest and dearest modes differ by at least 10x', () => {
    const costs = SEARCH_MODES.map((m) => m.relativeCost);
    expect(Math.max(...costs) / Math.min(...costs)).toBeGreaterThanOrEqual(10);
  });
});

describe('SEARCH_MODES honesty (D7)', () => {
  test('every mode declares whether its cost was measured, and where', () => {
    for (const m of SEARCH_MODES) {
      expect(typeof m.relativeCost).toBe('number');           // upstream's claim
      expect('measuredCost' in m).toBe(true);                  // ours, or null
      if (m.measuredCost !== null) {
        expect(m.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(typeof m.measuredOn).toBe('string');            // the corpus
        expect(m.measuredOn!.length).toBeGreaterThan(0);
      } else {
        expect(m.measuredAt).toBeNull();
        expect(m.measuredOn).toBeNull();
      }
    }
  });

  test('the cheapest measured mode is the baseline, exactly 1', () => {
    const measured = SEARCH_MODES.filter((m) => m.measuredCost !== null);
    if (measured.length === 0) return;                         // nothing measured yet is legal
    expect(Math.min(...measured.map((m) => m.measuredCost!))).toBe(1);
  });
});
