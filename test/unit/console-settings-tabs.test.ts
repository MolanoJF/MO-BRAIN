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

describe('the registry: thirteen tabs, in the deliberate menu order', () => {
  test('all thirteen ids appear, in the order the product owner asked for', () => {
    // schedules sits right after access, not at the end — a reordering here
    // is a product change to the settings menu, not a harmless refactor.
    // mcp sits directly under My Brain, for every role, in either mode.
    // appearance sits LAST for a mechanical reason, asserted below: the first
    // visible tab is what resolveTab(null, …) opens settings on.
    expect(SETTINGS_TABS.map((t) => t.id)).toEqual([
      'general', 'mine', 'mcp', 'sources', 'schema', 'members', 'access', 'schedules',
      'health', 'spend', 'runs', 'upgrades', 'appearance',
    ]);
    expect(SETTINGS_TABS).toHaveLength(13);
  });

  test('minRole matches the design doc\'s table exactly', () => {
    const roles = Object.fromEntries(SETTINGS_TABS.map((t) => [t.id, t.minRole]));
    expect(roles).toEqual({
      general: 'admin',
      mine: 'viewer',
      mcp: 'viewer',
      sources: 'admin', schema: 'admin', members: 'admin', access: 'admin',
      schedules: 'viewer', health: 'viewer', spend: 'admin', runs: 'viewer',
      upgrades: 'viewer', appearance: 'viewer',
    });
  });
});

describe('visibleTabs: role-gated menu contents', () => {
  test('an admin sees all thirteen tabs, in registry order', () => {
    expect(visibleTabs(true)).toHaveLength(13);
    expect(visibleTabs(true).map((t) => t.id)).toEqual(SETTINGS_TABS.map((t) => t.id));
  });

  test('a non-admin sees exactly the seven viewer tabs, in order', () => {
    // mcp is the tab a member's list gains, immediately after mine.
    expect(visibleTabs(false).map((t) => t.id)).toEqual([
      'mine', 'mcp', 'schedules', 'health', 'runs', 'upgrades', 'appearance',
    ]);
  });

  test('appearance is visible to EVERY role — the theme is not a permission', () => {
    // The one tab that is about the person looking at the screen rather than
    // about what they are allowed to do. An admin-gated dark mode is a member
    // stuck staring at the wrong one.
    expect(visibleTabs(false).map((t) => t.id)).toContain('appearance');
    expect(visibleTabs(true).map((t) => t.id)).toContain('appearance');
  });

  test('appearance is last, so it never becomes the default settings landing', () => {
    // resolveTab(null, …) returns the FIRST visible tab, which is what opening
    // settings lands on. Moving a preferences tab to the top of the registry
    // would silently move every admin off General and every member off
    // My Brain — a product change disguised as a reordering.
    expect(visibleTabs(true).at(-1)!.id).toBe('appearance');
    expect(visibleTabs(false).at(-1)!.id).toBe('appearance');
    expect(resolveTab(null, true)).not.toBe('appearance');
    expect(resolveTab(null, false)).not.toBe('appearance');
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
    expect(resolveTab('spend', false)).toBe('mine');
  });

  test('an unknown segment falls back to the first visible tab', () => {
    expect(resolveTab('nonsense', true)).toBe('general');
    expect(resolveTab('nonsense', false)).toBe('mine');
  });

  test('no requested tab at all (null) also falls back, same as unknown', () => {
    expect(resolveTab(null, true)).toBe('general');
    expect(resolveTab(null, false)).toBe('mine');
  });
});

describe('personal mode hides the team tabs', () => {
  test('an admin in personal mode sees no Members or Access', () => {
    const ids = visibleTabs(true, 'personal').map((t) => t.id);
    expect(ids).not.toContain('members');
    expect(ids).not.toContain('access');
    expect(ids[0]).toBe('general');
  });

  test('company mode is the default and shows them', () => {
    expect(visibleTabs(true).map((t) => t.id)).toContain('members');
    expect(visibleTabs(true, 'company').map((t) => t.id)).toContain('access');
  });

  test('a pasted members URL in personal mode lands on General', () => {
    expect(resolveTab('members', true, 'personal')).toBe('general');
  });

  test('admins open settings on General', () => {
    expect(resolveTab(null, true)).toBe('general');
  });

  test('a member opens settings on My Brain', () => {
    expect(resolveTab(null, false)).toBe('mine');
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

  test('opening settings still lands on General or My Brain, never MCP, and appearance stays last', () => {
    expect(resolveTab(null, true)).toBe('general');
    expect(resolveTab(null, false)).toBe('mine');
    expect(resolveTab(null, true, 'personal')).toBe('general');
    expect(resolveTab(null, false, 'personal')).toBe('mine');
    expect(resolveTab('mcp', true)).toBe('mcp');
    expect(resolveTab('mcp', false, 'personal')).toBe('mcp');
    expect(visibleTabs(true).at(-1)!.id).toBe('appearance');
    expect(visibleTabs(false).at(-1)!.id).toBe('appearance');
    expect(visibleTabs(true, 'personal').at(-1)!.id).toBe('appearance');
  });

  test('a member pasting /settings/spend still lands on My Brain', () => {
    expect(resolveTab('spend', false)).toBe('mine');
  });
});
