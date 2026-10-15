// test/unit/collectors-model.test.ts
import { describe, expect, test } from 'bun:test';
import { isDue, nextDue, parseCadence, parseCollector, type LastRun } from '../../src/server/collectors/model.ts';

const H = 3600_000;
const now = new Date('2026-10-14T12:00:00Z');

describe('parseCadence', () => {
  test('accepts minutes, hours, days, daily@HH:MM and once', () => {
    expect(parseCadence('30m')).toEqual({ kind: 'every', ms: 30 * 60_000 });
    expect(parseCadence('2h')).toEqual({ kind: 'every', ms: 2 * H });
    expect(parseCadence('1d')).toEqual({ kind: 'every', ms: 24 * H });
    expect(parseCadence('daily@07:30')).toEqual({ kind: 'daily', hour: 7, minute: 30 });
    expect(parseCadence('once')).toEqual({ kind: 'once' });
  });
  test('refuses under 15 minutes and garbage', () => {
    expect(parseCadence('10m')).toBeNull();
    expect(parseCadence('daily@25:00')).toBeNull();
    expect(parseCadence('weekly')).toBeNull();
  });
});

describe('parseCollector', () => {
  const fm = { type: 'collector', title: 'Mail', kind: 'email', enabled: true, cadence: '2h', harness: 'claude-code', allowed_tools: ['mcp__gmail__*'], target_source: 'p-ada', backfill_days: 90 };
  test('accepts a valid page', () => {
    const r = parseCollector('system/collectors/mail', 'p-ada', fm);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config).toMatchObject({ slug: 'system/collectors/mail', source: 'p-ada', kind: 'email', timeoutS: 1200 });
  });
  test('lists every problem', () => {
    const r = parseCollector('system/collectors/x', 'p-ada', { ...fm, kind: 'fax', cadence: '5m', allowed_tools: [], target_source: 'p-other' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(['kind', 'cadence', 'allowed_tools', 'target_source']);
  });
  test('fixture collectors need no allowed tools', () => {
    expect(parseCollector('system/collectors/f', 'p-ada', { ...fm, kind: 'fixture', allowed_tools: [] }).ok).toBe(true);
  });
});

describe('isDue', () => {
  const cfg = (cadence: string, enabled = true) => {
    const r = parseCollector('s', 'p', { type: 'collector', kind: 'email', enabled, cadence, allowed_tools: ['t'], target_source: 'p' });
    if (!r.ok) throw new Error('bad'); return r.config;
  };
  const run = (over: Partial<LastRun>): LastRun => ({ startedAt: new Date(now.getTime() - H), finishedAt: new Date(now.getTime() - H), status: 'ok', timeoutS: 1200, ...over });

  test('never run is due; disabled is never due', () => {
    expect(isDue(cfg('2h'), null, now)).toBe(true);
    expect(isDue(cfg('2h', false), null, now)).toBe(false);
  });
  test('every: due once the cadence has elapsed since the last finish', () => {
    expect(isDue(cfg('2h'), run({}), now)).toBe(false);
    expect(isDue(cfg('30m'), run({}), now)).toBe(true);
  });
  test('a live running row is not due; a stale running row is due again (Review Focus #3)', () => {
    expect(isDue(cfg('30m'), run({ status: 'running', finishedAt: null, startedAt: new Date(now.getTime() - 5 * 60_000) }), now)).toBe(false);
    expect(isDue(cfg('30m'), run({ status: 'running', finishedAt: null, startedAt: new Date(now.getTime() - 2 * H) }), now)).toBe(true);
  });
  test('daily: due after today\'s time when the last finish was before it', () => {
    expect(isDue(cfg('daily@07:00'), run({ finishedAt: new Date('2026-10-13T08:00:00Z') }), now)).toBe(true);
    expect(isDue(cfg('daily@07:00'), run({ finishedAt: new Date('2026-10-14T07:05:00Z') }), now)).toBe(false);
    expect(isDue(cfg('daily@13:00'), run({ finishedAt: new Date('2026-10-13T13:05:00Z') }), now)).toBe(false);
  });
  test('once: due only if it never finished ok', () => {
    expect(isDue(cfg('once'), run({}), now)).toBe(false);
    expect(isDue(cfg('once'), run({ status: 'error' }), now)).toBe(true);
  });
  test('nextDue for every is last finish + cadence', () => {
    expect(nextDue(cfg('2h'), run({}), now)!.toISOString()).toBe('2026-10-14T13:00:00.000Z');
  });
});
