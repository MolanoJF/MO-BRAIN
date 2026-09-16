import { test, expect, describe } from 'bun:test';
import {
  occurrencesIn, applyCatchup, MAX_OCCURRENCES_PER_TICK,
  type CalendarSpec, type IntervalSpec,
} from '../../src/scheduler/occurrences.ts';

const NY = 'America/New_York';
const every5 = (anchorMs: number): IntervalSpec =>
  ({ kind: 'interval', intervalSeconds: 300, anchorMs });
const daily = (hour: number, minute: number, over: Partial<CalendarSpec> = {}): CalendarSpec => ({
  kind: 'calendar', hour, minute, daysOfWeek: null,
  gapPolicy: 'shift', ambiguousPolicy: 'first', ...over,
});

describe('interval occurrences', () => {
  test('are exclusive of `from` and inclusive of `to`', () => {
    const anchor = Date.UTC(2026, 8, 15, 0, 0);
    const got = occurrencesIn(NY, every5(anchor), anchor, anchor + 900_000);
    expect(got.map((o) => o.fireAtMs)).toEqual([
      anchor + 300_000, anchor + 600_000, anchor + 900_000,
    ]);
  });

  test('do not drift across the spring-forward gap — every gap is exactly 300s', () => {
    const from = Date.UTC(2026, 2, 8, 6, 50);
    const to = Date.UTC(2026, 2, 8, 7, 30);
    const got = occurrencesIn(NY, every5(Date.UTC(2026, 2, 8, 0, 0)), from, to);
    for (let i = 1; i < got.length; i++) {
      expect(got[i]!.fireAtMs - got[i - 1]!.fireAtMs).toBe(300_000);
    }
    // 01:55 EST is immediately followed by 03:00 EDT: the wall clock jumps, the
    // real interval does not.
    const labels = got.map((o) => o.slot);
    expect(labels).toContain('2026-03-08T01:55');
    expect(labels).toContain('2026-03-08T03:00');
    expect(labels.some((l) => l.startsWith('2026-03-08T02:'))).toBe(false);
  });

  test('every slot across the fall-back repeat is unique, and the repeat is suffixed', () => {
    const from = Date.UTC(2026, 10, 1, 4, 55);
    const to = Date.UTC(2026, 10, 1, 7, 5);
    const got = occurrencesIn(NY, every5(Date.UTC(2026, 10, 1, 0, 0)), from, to);
    expect(got.length).toBe(26); // exclusive of `from`
    expect(new Set(got.map((o) => o.slot)).size).toBe(got.length);
    expect(got.filter((o) => o.slot.endsWith('#2')).length).toBe(12); // 01:00..01:55
    for (let i = 1; i < got.length; i++) {
      expect(got[i]!.fireAtMs - got[i - 1]!.fireAtMs).toBe(300_000);
    }
  });

  test('an anchor in the future produces nothing before it', () => {
    const anchor = Date.UTC(2026, 8, 20, 0, 0);
    expect(occurrencesIn(NY, every5(anchor), Date.UTC(2026, 8, 15, 0, 0), Date.UTC(2026, 8, 16, 0, 0)))
      .toEqual([]);
  });

  test('refuses a non-positive interval', () => {
    expect(() => occurrencesIn(NY, { kind: 'interval', intervalSeconds: 0, anchorMs: 0 }, 0, 1000))
      .toThrow(/intervalSeconds/);
  });

  test('refuses an unbounded window rather than materializing forever', () => {
    const anchor = Date.UTC(2026, 0, 1, 0, 0);
    expect(() => occurrencesIn(NY, every5(anchor), anchor, anchor + 365 * 86_400_000))
      .toThrow(/too many occurrences/);
  });
});

describe('calendar occurrences', () => {
  test('a daily 02:30 job fires once a day at the right instant', () => {
    const got = occurrencesIn(NY, daily(2, 30),
      Date.UTC(2026, 8, 14, 0, 0), Date.UTC(2026, 8, 17, 0, 0));
    expect(got.map((o) => o.fireAtMs)).toEqual([
      Date.UTC(2026, 8, 14, 6, 30), Date.UTC(2026, 8, 15, 6, 30), Date.UTC(2026, 8, 16, 6, 30),
    ]);
  });

  test('daysOfWeek filters to the named local weekdays', () => {
    // 2026-09-14 is a Monday.
    const got = occurrencesIn(NY, daily(6, 10, { daysOfWeek: [1] }),
      Date.UTC(2026, 8, 13, 0, 0), Date.UTC(2026, 8, 22, 0, 0));
    expect(got.map((o) => o.slot)).toEqual(['2026-09-14T06:10', '2026-09-21T06:10']);
  });

  test('gap_policy shift moves a nonexistent 02:30 to 03:30 local', () => {
    const got = occurrencesIn(NY, daily(2, 30),
      Date.UTC(2026, 2, 8, 0, 0), Date.UTC(2026, 2, 8, 23, 0));
    expect(got.length).toBe(1);
    expect(got[0]!.fireAtMs).toBe(Date.UTC(2026, 2, 8, 7, 30));
    expect(got[0]!.slot).toBe('2026-03-08T03:30');
  });

  test('gap_policy skip drops the occurrence entirely', () => {
    const got = occurrencesIn(NY, daily(2, 30, { gapPolicy: 'skip' }),
      Date.UTC(2026, 2, 8, 0, 0), Date.UTC(2026, 2, 8, 23, 0));
    expect(got).toEqual([]);
  });

  test('ambiguous_policy first fires once on the fall-back day, never twice', () => {
    const got = occurrencesIn(NY, daily(1, 30),
      Date.UTC(2026, 10, 1, 0, 0), Date.UTC(2026, 10, 1, 23, 0));
    expect(got.length).toBe(1);
    expect(got[0]!.fireAtMs).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(got[0]!.slot).toBe('2026-11-01T01:30'); // no #2 suffix
  });

  test('ambiguous_policy second picks the later instant; both picks two distinct slots', () => {
    const second = occurrencesIn(NY, daily(1, 30, { ambiguousPolicy: 'second' }),
      Date.UTC(2026, 10, 1, 0, 0), Date.UTC(2026, 10, 1, 23, 0));
    expect(second.map((o) => o.fireAtMs)).toEqual([Date.UTC(2026, 10, 1, 6, 30)]);
    expect(second[0]!.slot).toBe('2026-11-01T01:30#2');

    const both = occurrencesIn(NY, daily(1, 30, { ambiguousPolicy: 'both' }),
      Date.UTC(2026, 10, 1, 0, 0), Date.UTC(2026, 10, 1, 23, 0));
    expect(both.map((o) => o.slot)).toEqual(['2026-11-01T01:30', '2026-11-01T01:30#2']);
  });

  test('results are ascending by fire time and free of duplicate slots', () => {
    const got = occurrencesIn(NY, daily(1, 30, { ambiguousPolicy: 'both' }),
      Date.UTC(2026, 9, 30, 0, 0), Date.UTC(2026, 10, 3, 0, 0));
    for (let i = 1; i < got.length; i++) {
      expect(got[i]!.fireAtMs).toBeGreaterThan(got[i - 1]!.fireAtMs);
    }
    expect(new Set(got.map((o) => o.slot)).size).toBe(got.length);
  });
});

describe('catch-up classification', () => {
  const now = Date.UTC(2026, 8, 15, 12, 0);
  const grace = 120_000;
  const occ = (minutesAgo: number) => ({
    fireAtMs: now - minutesAgo * 60_000, slot: `t-${minutesAgo}`,
  });
  // Three genuinely missed, one inside the grace window.
  const window = [occ(30), occ(20), occ(10), occ(1)];

  test('skip (the default) runs only what is inside the grace window', () => {
    const { run, skipped } = applyCatchup(window, now, grace, 'skip');
    expect(run.map((o) => o.slot)).toEqual(['t-1']);
    expect(skipped.map((o) => o.slot)).toEqual(['t-30', 't-20', 't-10']);
  });

  test('run_latest adds exactly the most recent missed occurrence', () => {
    const { run, skipped } = applyCatchup(window, now, grace, 'run_latest');
    expect(run.map((o) => o.slot)).toEqual(['t-10', 't-1']);
    expect(skipped.map((o) => o.slot)).toEqual(['t-30', 't-20']);
  });

  test('run_all runs everything and skips nothing', () => {
    const { run, skipped } = applyCatchup(window, now, grace, 'run_all');
    expect(run.map((o) => o.slot)).toEqual(['t-30', 't-20', 't-10', 't-1']);
    expect(skipped).toEqual([]);
  });

  test('run_all is capped so a week of downtime is not a thundering herd', () => {
    const many = Array.from({ length: 80 }, (_, i) => occ(80 - i));
    const { run, skipped } = applyCatchup(many, now, grace, 'run_all', 50);
    expect(run.length).toBe(50);
    expect(skipped.length).toBe(30);
    // The cap drops the OLDEST, keeping the most recent 50.
    expect(skipped.every((s) => s.fireAtMs < run[0]!.fireAtMs)).toBe(true);
  });

  test('nothing missed means nothing skipped under any policy', () => {
    for (const policy of ['skip', 'run_latest', 'run_all'] as const) {
      const { run, skipped } = applyCatchup([occ(1)], now, grace, policy);
      expect(run.map((o) => o.slot)).toEqual(['t-1']);
      expect(skipped).toEqual([]);
    }
  });

  test('the per-tick occurrence cap is a real number, not Infinity', () => {
    expect(MAX_OCCURRENCES_PER_TICK).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_OCCURRENCES_PER_TICK)).toBe(true);
  });
});
