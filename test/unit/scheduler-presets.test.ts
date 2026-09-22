import { test, expect, describe } from 'bun:test';
import { PRESETS } from '../../src/scheduler/presets.ts';
import { SCHEDULER_COMMANDS, validateParams } from '../../src/scheduler/commands.ts';
import { ASSIGNABLE_SLOTS, isSubHourly } from '../../src/scheduler/stagger.ts';

describe('the preset catalog', () => {
  test('ships five user presets: four commands and one agent run', () => {
    const user = Object.values(PRESETS).filter((p) => !p.system).map((p) => p.id).sort();
    expect(user).toEqual([
      'autopilot-tripwire', 'live-sync', 'nightly-agent-briefing', 'nightly-dream', 'weekly-health',
    ]);
  });

  test('and exactly two conditional system schedules', () => {
    const system = Object.values(PRESETS).filter((p) => p.system).map((p) => p.id).sort();
    expect(system).toEqual(['morning-briefing', 'push-reconcile']);
  });

  test('exactly one of them is an agent run — don\'t over-cron, and don\'t over-spend', () => {
    const agent = Object.values(PRESETS).filter((p) => p.jobType === 'agent_prompt');
    expect(agent.map((p) => p.id)).toEqual(['nightly-agent-briefing']);
    // An agent preset carries a payload and no operation: shape_matches_job_type
    // allows exactly one payload shape per row, and this is the other one.
    expect(agent[0]!.agent).toBeDefined();
    expect(agent[0]!.operation).toBeNull();
  });

  test('every preset names a schedulable command (the internal drains do not)', () => {
    for (const p of Object.values(PRESETS)) {
      // An agent preset stores a prompt, not an argv: there is no allowlist
      // entry to name, and the row's operation is NULL by CHECK.
      if (p.jobType === 'agent_prompt') { expect(p.operation).toBeNull(); continue; }
      if (p.id === 'morning-briefing') { expect(p.operation).toBeNull(); continue; }
      expect(SCHEDULER_COMMANDS[p.operation!]).toBeDefined();
    }
  });

  test('every preset\'s params survive its own command\'s validator', () => {
    for (const p of Object.values(PRESETS)) {
      const op = p.operation;
      if (!op) continue;
      expect(() => validateParams(SCHEDULER_COMMANDS[op]!, p.params)).not.toThrow();
    }
  });

  test('live-sync defaults to 15 minutes and offers the roadmap\'s ladder', () => {
    const p = PRESETS['live-sync']!;
    expect(p.kind).toBe('interval');
    expect(p.defaults.intervalSeconds).toBe(900);
    expect(p.tunableInterval).toEqual([300, 600, 900, 1200, 1800]);
    expect(isSubHourly(p.defaults.intervalSeconds!)).toBe(true);
    expect(p.defaults.reportPolicy).toBe('on_change_or_failure');
  });

  test('nightly-dream runs at 02:05 and weekly-health Mondays at 06:10', () => {
    expect(PRESETS['nightly-dream']!.defaults).toMatchObject({
      calendarHour: 2, calendarMinute: 5, slotMinute: 5, calendarDaysOfWeek: null,
    });
    expect(PRESETS['weekly-health']!.defaults).toMatchObject({
      calendarHour: 6, calendarMinute: 10, slotMinute: 10, calendarDaysOfWeek: [1],
    });
  });

  test('weekly-health carries the max-usd ceiling the roadmap names', () => {
    expect(PRESETS['weekly-health']!.params).toEqual({ remediate: true, yes: true, maxUsd: 5 });
  });

  test('autopilot-tripwire: daily 07:05, admin-gated, short, and quiet when healthy', () => {
    const p = PRESETS['autopilot-tripwire']!;
    expect(p.operation).toBe('autopilot-status');
    expect(p.kind).toBe('calendar');
    expect(p.params).toEqual({});
    expect(p.requiresRole).toBe('admin');
    expect(p.system).toBeUndefined();
    expect(p.defaults).toMatchObject({
      calendarHour: 7, calendarMinute: 5, slotMinute: 5, calendarDaysOfWeek: null,
      catchupPolicy: 'skip', overlapPolicy: 'skip',
      // A healthy day has nothing to say; an install or an unreadable probe
      // always reports (changeCount 1 or null).
      reportPolicy: 'on_change_or_failure',
      timeoutSeconds: 60,
    });
  });

  test('every calendar preset lands on an assignable slot, never :00', () => {
    for (const p of Object.values(PRESETS)) {
      if (p.kind !== 'calendar') continue;
      expect(ASSIGNABLE_SLOTS as readonly number[]).toContain(p.defaults.slotMinute!);
      expect(p.defaults.calendarMinute).toBe(p.defaults.slotMinute);
    }
  });

  test('every calendar preset occupies a DISTINCT slot — they cannot collide on install', () => {
    const calendar = Object.values(PRESETS).filter((p) => p.kind === 'calendar');
    const keys = calendar.map((p) => `${p.defaults.calendarHour}:${p.defaults.slotMinute}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('weekly-health is brain-wide and therefore admin-gated', () => {
    expect(SCHEDULER_COMMANDS[PRESETS['weekly-health']!.operation!]!.scope).toBe('brain-wide');
    expect(PRESETS['weekly-health']!.requiresRole).toBe('admin');
  });

  test('every brain-wide preset is admin-gated', () => {
    for (const p of Object.values(PRESETS)) {
      if (!p.operation || SCHEDULER_COMMANDS[p.operation]?.scope !== 'brain-wide') continue;
      expect(p.requiresRole).toBe('admin');
    }
  });

  test('no preset schedules check-update — that is Slice 3.5', () => {
    expect(Object.values(PRESETS).some((p) => p.operation === 'checkUpdate')).toBe(false);
  });
});
