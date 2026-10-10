import { test, expect, describe } from 'bun:test';
import {
  SETTINGS_TABS, visibleTabs, isSettingsTab, resolveTab, settingsTabForSegment,
} from '../../src/console/settings/tabs.ts';

/**
 * These are trust properties, not shape assertions: this registry decides
 * what a member can see and where a bad URL lands them. Getting either
 * wrong either leaks an admin page to a member, or strands someone on a
 * blank panel.
 */

describe('the registry: ten tabs, General first for everyone', () => {
  test('ids appear in the order the product owner asked for', () => {
    // General is first, and it is viewer: opening settings lands here for an
    // admin and a member. Admin is the old General (name, mode) and sits
    // second so it never becomes that landing. Runner keeps the `runs` id so
    // a bookmarked /settings/runs still opens it; only the label changed.
    expect(SETTINGS_TABS.map((t) => t.id)).toEqual([
      'general', 'admin', 'mine', 'mcp', 'sources', 'schema', 'members', 'access', 'schedules',
      'runs',
    ]);
    expect(SETTINGS_TABS).toHaveLength(10);
    expect(SETTINGS_TABS.find((t) => t.id === 'runs')).toEqual({
      id: 'runs', label: 'Runner', minRole: 'viewer',
    });
  });

  test('minRole matches who may see each tab', () => {
    const roles = Object.fromEntries(SETTINGS_TABS.map((t) => [t.id, t.minRole]));
    expect(roles).toEqual({
      general: 'viewer',
      admin: 'admin',
      mine: 'viewer',
      mcp: 'viewer',
      sources: 'admin', schema: 'admin', members: 'admin', access: 'admin',
      schedules: 'viewer', runs: 'viewer',
    });
  });

  test('health, spend, upgrades, and appearance are not tabs', () => {
    const ids = SETTINGS_TABS.map((t) => t.id);
    expect(ids).not.toContain('health');
    expect(ids).not.toContain('spend');
    expect(ids).not.toContain('upgrades');
    expect(ids).not.toContain('appearance');
  });
});

describe('visibleTabs: role-gated menu contents', () => {
  test('an admin sees all ten tabs, in registry order', () => {
    expect(visibleTabs(true)).toHaveLength(10);
    expect(visibleTabs(true).map((t) => t.id)).toEqual(SETTINGS_TABS.map((t) => t.id));
  });

  test('a non-admin sees exactly the five viewer tabs, in order', () => {
    expect(visibleTabs(false).map((t) => t.id)).toEqual([
      'general', 'mine', 'mcp', 'schedules', 'runs',
    ]);
  });

  test('a non-admin never sees Admin, spend, or members', () => {
    const ids = visibleTabs(false).map((t) => t.id);
    expect(ids).not.toContain('admin');
    expect(ids).not.toContain('spend');
    expect(ids).not.toContain('members');
  });
});

describe('isSettingsTab: the narrowing the router needs for a raw URL segment', () => {
  test('accepts every real id', () => {
    for (const t of SETTINGS_TABS) expect(isSettingsTab(t.id)).toBe(true);
  });

  test('rejects a near-miss and a retired tab id — a retired id is not a tab', () => {
    expect(isSettingsTab('Source')).toBe(false);
    expect(isSettingsTab('settings')).toBe(false);
    expect(isSettingsTab('')).toBe(false);
    expect(isSettingsTab('health')).toBe(false);
    expect(isSettingsTab('spend')).toBe(false);
    expect(isSettingsTab('appearance')).toBe(false);
  });
});

describe('settingsTabForSegment: retired bookmarks still open a page', () => {
  test('health, upgrades, appearance, and spend open General', () => {
    expect(settingsTabForSegment('health')).toBe('general');
    expect(settingsTabForSegment('upgrades')).toBe('general');
    expect(settingsTabForSegment('appearance')).toBe('general');
    expect(settingsTabForSegment('spend')).toBe('general');
  });

  test('a live tab is itself', () => {
    expect(settingsTabForSegment('admin')).toBe('admin');
    expect(settingsTabForSegment('runs')).toBe('runs');
  });

  test('garbage is not a tab', () => {
    expect(settingsTabForSegment('nope')).toBeNull();
  });
});

describe('resolveTab: what the modal actually opens on', () => {
  test('a valid, visible tab opens as asked', () => {
    expect(resolveTab('members', true)).toBe('members');
    expect(resolveTab('general', false)).toBe('general');
    expect(resolveTab('runs', false)).toBe('runs');
  });

  test('a member pasting an admin URL gets General, never an empty panel', () => {
    expect(resolveTab('admin', false)).not.toBe('admin');
    expect(resolveTab('admin', false)).toBe('general');
    expect(resolveTab('spend', false)).toBe('general');
  });

  test('a retired tab id falls back to General for both roles', () => {
    expect(resolveTab('health', true)).toBe('general');
    expect(resolveTab('appearance', false)).toBe('general');
    expect(resolveTab('upgrades', true)).toBe('general');
  });

  test('an unknown segment falls back to the first visible tab', () => {
    expect(resolveTab('nonsense', true)).toBe('general');
    expect(resolveTab('nonsense', false)).toBe('general');
  });

  test('no requested tab at all (null) also falls back, same as unknown', () => {
    expect(resolveTab(null, true)).toBe('general');
    expect(resolveTab(null, false)).toBe('general');
  });
});

describe('personal mode hides the team tabs', () => {
  test('an admin in personal mode sees no Members or Access', () => {
    const ids = visibleTabs(true, 'personal').map((t) => t.id);
    expect(ids).not.toContain('members');
    expect(ids).not.toContain('access');
    expect(ids[0]).toBe('general');
    expect(ids).toContain('admin');
  });

  test('company mode is the default and shows them', () => {
    expect(visibleTabs(true).map((t) => t.id)).toContain('members');
    expect(visibleTabs(true, 'company').map((t) => t.id)).toContain('access');
  });

  test('a pasted members URL in personal mode lands on General', () => {
    expect(resolveTab('members', true, 'personal')).toBe('general');
  });

  test('everyone opens settings on General, never on Admin or MCP', () => {
    expect(resolveTab(null, true)).toBe('general');
    expect(resolveTab(null, false)).toBe('general');
    expect(resolveTab(null, true, 'personal')).toBe('general');
    expect(resolveTab(null, false, 'personal')).toBe('general');
    expect(resolveTab('mcp', true)).toBe('mcp');
    expect(resolveTab('admin', true)).toBe('admin');
  });
});

describe('mcp is under My Brain for every role, and it is not the landing', () => {
  test('mcp is viewer, not company-only, and present for an admin, a member, and personal mode', () => {
    const entry = SETTINGS_TABS.find((t) => t.id === 'mcp');
    expect(entry).toEqual({ id: 'mcp', label: 'MCP', minRole: 'viewer' });
    expect(visibleTabs(true).map((t) => t.id)).toContain('mcp');
    expect(visibleTabs(false).map((t) => t.id)).toContain('mcp');
    expect(visibleTabs(true, 'personal').map((t) => t.id)).toContain('mcp');
    expect(visibleTabs(false, 'personal').map((t) => t.id)).toContain('mcp');
    const member = visibleTabs(false).map((t) => t.id);
    expect(member[member.indexOf('mine') + 1]).toBe('mcp');
  });
});
