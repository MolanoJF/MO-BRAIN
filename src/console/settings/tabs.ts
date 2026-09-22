/**
 * The settings tab registry — a leaf module.
 *
 * It imports nothing from the console except types, and must stay that way.
 * `router.ts` needs the `SettingsTab` union at parse time, to validate a URL
 * segment; the settings panel that actually renders each tab is lazily
 * loaded and comparatively large. If this module pulled in even a
 * type-only reference to that panel, the router would sit one refactor away
 * from an import cycle: router -> panel -> (something) -> router. Mirrors
 * upstream baalda's `lib/settingsTabs.ts`, which exists for the same
 * reason.
 *
 * `minRole` is a two-value axis (`'admin' | 'viewer'`) and nothing else,
 * because that is all the console client can actually tell about the
 * caller. `src/console/App.tsx`'s `phaseFor` already treats a 403 from
 * `GET /api/wizard/state` as "a valid session without the admin role" —
 * that probe is the console's only role signal, and it draws exactly one
 * line: admin or not. There is no viewer/editor/owner distinction available
 * on the client, so this module does not invent one.
 */

export type SettingsTab =
  | 'sources' | 'schema' | 'members' | 'access' | 'schedules'
  | 'health' | 'spend' | 'runs' | 'upgrades' | 'appearance';

export type SettingsTabRole = 'admin' | 'viewer';

export interface SettingsTabEntry {
  readonly id: SettingsTab;
  readonly label: string;
  readonly minRole: SettingsTabRole;
}

/**
 * Registry order = menu order, and it is deliberate: `schedules` sits right
 * after `access`, not at the end, per the product owner's requested layout.
 *
 * `appearance` goes LAST, and that position is load-bearing rather than
 * aesthetic: `resolveTab(null, isAdmin)` returns the first visible tab, so
 * whatever sits at the top of this list is what opening settings lands on.
 * Putting a per-operator preference there would move every admin off Sources
 * and every member off Schedules on the way to a tab most people open once.
 */
export const SETTINGS_TABS: readonly SettingsTabEntry[] = [
  { id: 'sources', label: 'Sources', minRole: 'admin' },
  { id: 'schema', label: 'Schema', minRole: 'admin' },
  { id: 'members', label: 'Members', minRole: 'admin' },
  { id: 'access', label: 'Access', minRole: 'admin' },
  { id: 'schedules', label: 'Schedules', minRole: 'viewer' },
  { id: 'health', label: 'Health', minRole: 'viewer' },
  { id: 'spend', label: 'Spend', minRole: 'admin' },
  { id: 'runs', label: 'Runs', minRole: 'viewer' },
  { id: 'upgrades', label: 'Upgrades', minRole: 'viewer' },
  { id: 'appearance', label: 'Appearance', minRole: 'viewer' },
];

const SETTINGS_TAB_IDS: ReadonlySet<string> = new Set(SETTINGS_TABS.map((t) => t.id));

/**
 * The tabs a caller may see. An admin sees all ten; a non-admin sees only
 * the `minRole === 'viewer'` tabs, hidden rather than shown-and-disabled —
 * there is no locked/greyed state to design for, because a member never
 * sees the tab exists.
 *
 * `appearance` is `viewer`, which is to say everybody: the theme is a
 * property of the person looking at the screen, not of their permissions, and
 * an admin-gated dark mode would be a member staring at the wrong one.
 */
export function visibleTabs(isAdmin: boolean): SettingsTabEntry[] {
  return SETTINGS_TABS.filter((t) => isAdmin || t.minRole === 'viewer');
}

/** The narrowing the router needs to validate a raw URL segment. */
export function isSettingsTab(value: string): value is SettingsTab {
  return SETTINGS_TAB_IDS.has(value);
}

/**
 * What the modal actually opens on. A valid, visible tab opens as asked.
 * An unknown segment, or a tab the caller's role cannot see, falls back to
 * the first visible tab — `sources` for an admin, `schedules` for a member
 * — rather than showing an empty panel. This matters most for the case
 * that looks harmless: `spend` is a real, valid tab id, so checking
 * `isSettingsTab` alone would let a member's pasted admin URL through.
 */
export function resolveTab(requested: string | null, isAdmin: boolean): SettingsTab {
  const visible = visibleTabs(isAdmin);
  if (requested !== null && isSettingsTab(requested) && visible.some((t) => t.id === requested)) {
    return requested;
  }
  return visible[0]!.id;
}
