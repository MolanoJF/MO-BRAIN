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
  | 'general' | 'admin' | 'sources' | 'schema' | 'mcp' | 'credentials' | 'members' | 'access'
  | 'schedules' | 'runs';

export type SettingsTabRole = 'admin' | 'viewer';

export interface SettingsTabEntry {
  readonly id: SettingsTab;
  readonly label: string;
  readonly minRole: SettingsTabRole;
  /** Zones spec D5: hidden in a personal brain, where the API refuses it anyway. */
  readonly companyOnly?: true;
}

/**
 * Registry order = menu order, and it is deliberate: `schedules` sits right
 * after `access`, not at the end, per the product owner's requested layout.
 * `credentials` sits right after `mcp`: both are per-member connection setup.
 *
 * `general` is first and `viewer`, so `resolveTab(null, …)` lands everyone on
 * it. Health, spend, upgrades, and appearance are sections of that page, not
 * tabs. `admin` is the org name and the personal/company switch; it sits
 * second so it never becomes the landing, and it is admin-only.
 *
 * `runs` keeps its id. The label is Runner: the page is runner status plus the
 * run ledger, and a bookmarked `/settings/runs` still has to open it.
 */
export const SETTINGS_TABS: readonly SettingsTabEntry[] = [
  { id: 'general', label: 'General', minRole: 'viewer' },
  { id: 'admin', label: 'Admin', minRole: 'admin' },
  { id: 'sources', label: 'Sources', minRole: 'viewer' },
  { id: 'schema', label: 'Schema', minRole: 'admin' },
  { id: 'mcp', label: 'MCP', minRole: 'viewer' },
  { id: 'credentials', label: 'Credentials', minRole: 'viewer' },
  { id: 'members', label: 'Members', minRole: 'admin', companyOnly: true },
  { id: 'access', label: 'Access', minRole: 'admin', companyOnly: true },
  { id: 'schedules', label: 'Schedules', minRole: 'viewer' },
  { id: 'runs', label: 'Runner', minRole: 'viewer' },
];

/**
 * Bookmarks from when Health, Spend, Upgrades, and Appearance were tabs.
 * They open General, where those pages now live as sections. Spend is still
 * admin-only inside that page; the URL itself is not a permission.
 */
const RETIRED_SETTINGS_TABS: Readonly<Record<string, SettingsTab>> = {
  health: 'general',
  spend: 'general',
  upgrades: 'general',
  appearance: 'general',
  mine: 'sources',
};

const SETTINGS_TAB_IDS: ReadonlySet<string> = new Set(SETTINGS_TABS.map((t) => t.id));

/**
 * The tabs a caller may see. An admin in company mode (the default) sees all
 * ten; a non-admin sees only the `minRole === 'viewer'` tabs, hidden
 * rather than shown-and-disabled — there is no locked/greyed state to design
 * for, because a member never sees the tab exists. Personal mode additionally
 * hides `companyOnly` tabs.
 *
 * General is `viewer`, which is to say everybody: the theme lives on that
 * page, and an admin-gated dark mode would be a member staring at the wrong
 * one. Spend is a section of the same page, mounted only for an admin.
 */
export function visibleTabs(isAdmin: boolean, mode: 'personal' | 'company' = 'company'): SettingsTabEntry[] {
  return SETTINGS_TABS.filter((t) =>
    (isAdmin || t.minRole === 'viewer') && !(mode === 'personal' && t.companyOnly));
}

/** The narrowing the router needs to validate a raw URL segment. */
export function isSettingsTab(value: string): value is SettingsTab {
  return SETTINGS_TAB_IDS.has(value);
}

/**
 * A live tab id, or the page a retired bookmark now opens. `null` for a typo:
 * the router falls back to the editor rather than inventing a tab.
 */
export function settingsTabForSegment(value: string): SettingsTab | null {
  if (isSettingsTab(value)) return value;
  return RETIRED_SETTINGS_TABS[value] ?? null;
}

/**
 * What the modal actually opens on. A valid, visible tab opens as asked.
 * An unknown segment, or a tab the caller's role cannot see, falls back to
 * the first visible tab — `general` for everyone — rather than showing an
 * empty panel. This matters most for the case that looks harmless: `admin`
 * is a real, valid tab id, so checking `isSettingsTab` alone would let a
 * member's pasted admin URL through. A retired id (`health`, `spend`,
 * `upgrades`, `appearance`) is not a tab, so it takes the same fallback.
 */
export function resolveTab(
  requested: string | null, isAdmin: boolean, mode: 'personal' | 'company' = 'company',
): SettingsTab {
  const visible = visibleTabs(isAdmin, mode);
  if (requested !== null && isSettingsTab(requested) && visible.some((t) => t.id === requested)) {
    return requested;
  }
  return visible[0]!.id;
}
