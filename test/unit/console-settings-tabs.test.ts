import { test, expect, describe } from 'bun:test';
import {
  SETTINGS_TABS, visibleTabs, isSettingsTab, resolveTab,
} from '../../src/console/settings/tabs.ts';

/**
 * These are trust properties, not shape assertions: this registry decides
 * what a member can see and where a bad URL lands them. Getting either
 * wrong either leaks an admin page to a member, or strands someone on a
 * blank panel.
 */

describe('the registry: nine tabs, in the deliberate menu order', () => {
  test('all nine ids appear, in the order the product owner asked for', () => {
    // schedules sits right after access, not at the end — a reordering here
    // is a product change to the settings menu, not a harmless refactor.
    expect(SETTINGS_TABS.map((t) => t.id)).toEqual([
      'sources', 'schema', 'members', 'access', 'schedules',
      'health', 'spend', 'runs', 'upgrades',
    ]);
  });

  test('minRole matches the design doc\'s table exactly', () => {
    const roles = Object.fromEntries(SETTINGS_TABS.map((t) => [t.id, t.minRole]));
    expect(roles).toEqual({
      sources: 'admin', schema: 'admin', members: 'admin', access: 'admin',
      schedules: 'viewer', health: 'viewer', spend: 'admin', runs: 'viewer',
      upgrades: 'viewer',
    });
  });
});

describe('visibleTabs: role-gated menu contents', () => {
  test('an admin sees all nine tabs, in registry order', () => {
    expect(visibleTabs(true).map((t) => t.id)).toEqual(SETTINGS_TABS.map((t) => t.id));
  });

  test('a non-admin sees exactly the four viewer tabs, in order', () => {
    expect(visibleTabs(false).map((t) => t.id)).toEqual(['schedules', 'health', 'runs', 'upgrades']);
  });

  test('a non-admin never sees spend or members — the two tabs closest to billing and headcount', () => {
    const ids = visibleTabs(false).map((t) => t.id);
    expect(ids).not.toContain('spend');
    expect(ids).not.toContain('members');
  });
});

describe('isSettingsTab: the narrowing the router needs for a raw URL segment', () => {
  test('accepts every real id', () => {
    for (const t of SETTINGS_TABS) expect(isSettingsTab(t.id)).toBe(true);
  });

  test('rejects a near-miss, not just garbage — a typo is not a tab', () => {
    expect(isSettingsTab('Source')).toBe(false);
    expect(isSettingsTab('settings')).toBe(false);
    expect(isSettingsTab('')).toBe(false);
  });
});

describe('resolveTab: what the modal actually opens on', () => {
  test('a valid, visible tab opens as asked', () => {
    expect(resolveTab('members', true)).toBe('members');
    expect(resolveTab('health', false)).toBe('health');
  });

  test('a member pasting an admin URL gets a usable panel, never an empty one', () => {
    // The exact regression this guards: spend is a real, valid tab id, so a
    // naive isSettingsTab-only check would let it through for anyone.
    expect(resolveTab('spend', false)).not.toBe('spend');
    expect(resolveTab('spend', false)).toBe('schedules');
  });

  test('an unknown segment falls back to the first visible tab', () => {
    expect(resolveTab('nonsense', true)).toBe('sources');
    expect(resolveTab('nonsense', false)).toBe('schedules');
  });

  test('no requested tab at all (null) also falls back, same as unknown', () => {
    expect(resolveTab(null, true)).toBe('sources');
    expect(resolveTab(null, false)).toBe('schedules');
  });
});
