import { test, expect, describe } from 'bun:test';
import {
  isValidTimeZone, zonedWallMs, offsetMs, wallOf, wallMsOf,
  localToInstants, gapShiftInstant, ambiguousPass, slotLabel, reportStamp, inQuietHours,
} from '../../src/scheduler/time.ts';

// US DST 2026: spring forward 2026-03-08 07:00Z, fall back 2026-11-01 06:00Z.
const NY = 'America/New_York';
const SPRING_GAP = { year: 2026, month: 3, day: 8, hour: 2, minute: 30 };
const FALL_AMBIG = { year: 2026, month: 11, day: 1, hour: 1, minute: 30 };

describe('timezone validation', () => {
  test('accepts IANA ids and UTC, rejects abbreviations and junk', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Europe/Zurich')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    // Intl accepts these; we do not — they are not per-org IANA zones.
    expect(isValidTimeZone('EST')).toBe(false);
    expect(isValidTimeZone('PST8PDT')).toBe(false);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('zoned wall clock', () => {
  test('offset flips across the spring-forward transition', () => {
    const before = Date.UTC(2026, 2, 8, 6, 59); // 01:59 EST
    const after = Date.UTC(2026, 2, 8, 7, 1);   // 03:01 EDT
    expect(offsetMs(NY, before)).toBe(-5 * 3_600_000);
    expect(offsetMs(NY, after)).toBe(-4 * 3_600_000);
  });

  test('midnight reads as hour 0, never hour 24', () => {
    const midnight = Date.UTC(2026, 8, 15, 4, 0); // 00:00 EDT
    expect(wallOf(NY, midnight).hour).toBe(0);
    expect(zonedWallMs(NY, midnight)).toBe(Date.UTC(2026, 8, 15, 0, 0, 0));
  });

  test('wallOf and wallMsOf round-trip', () => {
    const t = Date.UTC(2026, 8, 15, 18, 5);
    expect(wallMsOf(wallOf(NY, t))).toBe(zonedWallMs(NY, t));
  });
});

describe('local wall time to instants', () => {
  test('a normal wall time resolves to exactly one instant', () => {
    expect(localToInstants(NY, { year: 2026, month: 9, day: 15, hour: 2, minute: 30 }))
      .toEqual([Date.UTC(2026, 8, 15, 6, 30)]);
  });

  test('the spring-forward gap resolves to zero instants', () => {
    expect(localToInstants(NY, SPRING_GAP)).toEqual([]);
  });

  test('the fall-back repeat resolves to two ascending instants one hour apart', () => {
    const got = localToInstants(NY, FALL_AMBIG);
    expect(got).toEqual([Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 1, 6, 30)]);
    expect(got[1]! - got[0]!).toBe(3_600_000);
  });

  test('gapShiftInstant shifts a nonexistent 02:30 forward to 03:30 local', () => {
    const t = gapShiftInstant(NY, SPRING_GAP);
    expect(t).toBe(Date.UTC(2026, 2, 8, 7, 30));
    expect(wallOf(NY, t)).toMatchObject({ hour: 3, minute: 30 });
  });
});

describe('slot labels', () => {
  test('a normal instant gets a bare wall stamp', () => {
    expect(slotLabel(NY, Date.UTC(2026, 8, 15, 6, 30))).toBe('2026-09-15T02:30');
  });

  test('the second pass through an ambiguous hour is suffixed, the first is not', () => {
    expect(ambiguousPass(NY, Date.UTC(2026, 10, 1, 5, 30))).toBe(1);
    expect(ambiguousPass(NY, Date.UTC(2026, 10, 1, 6, 30))).toBe(2);
    expect(slotLabel(NY, Date.UTC(2026, 10, 1, 5, 30))).toBe('2026-11-01T01:30');
    expect(slotLabel(NY, Date.UTC(2026, 10, 1, 6, 30))).toBe('2026-11-01T01:30#2');
  });

  test('every five-minute instant across the fall-back window has a unique slot label', () => {
    const labels = new Set<string>();
    for (let t = Date.UTC(2026, 10, 1, 4, 55); t <= Date.UTC(2026, 10, 1, 7, 5); t += 300_000) {
      labels.add(slotLabel(NY, t));
    }
    expect(labels.size).toBe(27); // 04:55Z..07:05Z inclusive, every 5 min
  });

  test('report stamps follow upstream reports/<job>/<YYYY-MM-DD-HHMM>.md', () => {
    expect(reportStamp(NY, Date.UTC(2026, 8, 15, 6, 30))).toBe('2026-09-15-0230');
    expect(reportStamp(NY, Date.UTC(2026, 10, 1, 6, 30))).toBe('2026-11-01-0130-2');
  });
});

describe('quiet hours', () => {
  test('the default 23:00-08:00 window wraps midnight in org-local time', () => {
    const at = (h: number) => Date.UTC(2026, 8, 15, (h + 4) % 24, 0); // EDT = UTC-4
    expect(inQuietHours(NY, at(23), 23, 8)).toBe(true);
    expect(inQuietHours(NY, at(3), 23, 8)).toBe(true);
    expect(inQuietHours(NY, at(7), 23, 8)).toBe(true);
    expect(inQuietHours(NY, at(8), 23, 8)).toBe(false);
    expect(inQuietHours(NY, at(14), 23, 8)).toBe(false);
  });

  test('a non-wrapping window is handled too', () => {
    const at = (h: number) => Date.UTC(2026, 8, 15, (h + 4) % 24, 0);
    expect(inQuietHours(NY, at(10), 9, 12)).toBe(true);
    expect(inQuietHours(NY, at(12), 9, 12)).toBe(false);
  });
});
