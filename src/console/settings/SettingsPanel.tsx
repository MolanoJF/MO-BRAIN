import { lazy, Suspense, type ComponentType } from 'react';
import { visibleTabs, type SettingsTab } from './tabs.ts';
import { Button, NavItem } from '../ui/index.tsx';

/**
 * Every tab's page, lazily. `Schedules.tsx` (1,487 lines) and `Runs.tsx`
 * (1,026 lines) alone are roughly 40% of the console's page code by volume,
 * and none of it belongs in the editor's first paint — an operator hits the
 * shell every time they open a file, but only sometimes opens settings.
 * Each entry re-exports the page's named export as `default` because the
 * pages themselves export `export function Sources()` etc., not a default.
 */
const PAGES: Record<SettingsTab, ComponentType> = {
  general: lazy(() => import('../pages/General.tsx').then((m) => ({ default: m.General }))),
  mine: lazy(() => import('../pages/MyBrain.tsx').then((m) => ({ default: m.MyBrain }))),
  mcp: lazy(() => import('../pages/Mcp.tsx').then((m) => ({ default: m.Mcp }))),
  sources: lazy(() => import('../pages/Sources.tsx').then((m) => ({ default: m.Sources }))),
  schema: lazy(() => import('../pages/Schema.tsx').then((m) => ({ default: m.Schema }))),
  members: lazy(() => import('../pages/Members.tsx').then((m) => ({ default: m.Members }))),
  access: lazy(() => import('../pages/Access.tsx').then((m) => ({ default: m.Access }))),
  schedules: lazy(() => import('../pages/Schedules.tsx').then((m) => ({ default: m.Schedules }))),
  health: lazy(() => import('../pages/Health.tsx').then((m) => ({ default: m.Health }))),
  spend: lazy(() => import('../pages/Spend.tsx').then((m) => ({ default: m.Spend }))),
  runs: lazy(() => import('../pages/Runs.tsx').then((m) => ({ default: m.Runs }))),
  upgrades: lazy(() => import('../pages/Upgrades.tsx').then((m) => ({ default: m.Upgrades }))),
  appearance: lazy(() => import('../pages/Appearance.tsx').then((m) => ({ default: m.Appearance }))),
};

const LABEL: Record<SettingsTab, string> = {
  general: 'General',
  mine: 'My Brain',
  mcp: 'MCP',
  sources: 'Sources', schema: 'Schema', members: 'Members', access: 'Access',
  schedules: 'Schedules', health: 'Health', spend: 'Spend', runs: 'Runs', upgrades: 'Upgrades',
  appearance: 'Appearance',
};

/**
 * The modal's interior: the header, the tab nav, and the selected page.
 * Pages mount unchanged — this component never sees their props or internals,
 * only their default-exported component.
 *
 * Two `.nav-item` clusters used to live here, and neither does now.
 *
 * The header's Close is a `Button`: an ordinary auto-width control in a header
 * row, which is exactly what `Button` is. `settings-close` stays in its class
 * list on purpose — `Dialog`'s `initialFocus` defaults to that selector, and it
 * is how focus lands somewhere sensible when the modal opens. Dropping the
 * class would not fail a test; it would just quietly stop moving focus.
 *
 * The tab rows are `NavItem`. They are still not `Button`, for the reason the
 * migration reported: `buttonClass` sets a border and (until the layout became
 * a prop) centred its label, and `ui/classes.ts` states as a rule that no two
 * utilities in one class string may set the same property — so a caller cannot
 * reach in with `justify-start border-0` and rely on winning, because the
 * emitted CSS order decides, not the attribute order. A left-aligned,
 * borderless, full-width rail is a different control, so it got a primitive
 * instead of a prop that quietly undoes half of `Button`. This was the last
 * live `.nav-item` in the console, and that rule is now deleted.
 */
export function SettingsPanel({
  tab, isAdmin, mode, onTab, onClose,
}: {
  tab: SettingsTab;
  isAdmin: boolean;
  mode: 'personal' | 'company';
  onTab: (tab: SettingsTab) => void;
  onClose: () => void;
}) {
  const Page = PAGES[tab];
  return (
    <>
      <div className="settings-page-header">
        <h2>Settings</h2>
        <Button className="settings-close" onClick={onClose} aria-label="Close settings">
          Close
        </Button>
      </div>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {visibleTabs(isAdmin, mode).map((t) => (
            <NavItem key={t.id} active={t.id === tab} onClick={() => onTab(t.id)}>
              {t.label}
            </NavItem>
          ))}
        </nav>
        <section className="settings-content" aria-label={LABEL[tab]}>
          {/*
            A quiet fallback, not a spinner: this Suspense trips on every tab
            switch (each tab's page is its own lazy chunk), so a flashing
            spinner on ordinary navigation would be more distracting than the
            brief blank frame it replaces.
          */}
          <Suspense fallback={<div />}>
            <Page />
          </Suspense>
        </section>
      </div>
    </>
  );
}
