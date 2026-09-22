import { lazy, Suspense, type ComponentType } from 'react';
import { visibleTabs, type SettingsTab } from './tabs.ts';

/**
 * Every tab's page, lazily. `Schedules.tsx` (1,487 lines) and `Runs.tsx`
 * (1,026 lines) alone are roughly 40% of the console's page code by volume,
 * and none of it belongs in the editor's first paint — an operator hits the
 * shell every time they open a file, but only sometimes opens settings.
 * Each entry re-exports the page's named export as `default` because the
 * pages themselves export `export function Sources()` etc., not a default.
 */
const PAGES: Record<SettingsTab, ComponentType> = {
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
  sources: 'Sources', schema: 'Schema', members: 'Members', access: 'Access',
  schedules: 'Schedules', health: 'Health', spend: 'Spend', runs: 'Runs', upgrades: 'Upgrades',
  appearance: 'Appearance',
};

/**
 * The modal's interior: the header, the tab nav, and the selected page.
 * Pages mount unchanged — this component never sees their props or internals,
 * only their default-exported component.
 */
export function SettingsPanel({
  tab, isAdmin, onTab, onClose,
}: {
  tab: SettingsTab;
  isAdmin: boolean;
  onTab: (tab: SettingsTab) => void;
  onClose: () => void;
}) {
  const Page = PAGES[tab];
  return (
    <>
      <div className="settings-page-header">
        <h2>Settings</h2>
        <button className="nav-item settings-close" onClick={onClose} aria-label="Close settings">
          Close
        </button>
      </div>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {visibleTabs(isAdmin).map((t) => (
            <button
              key={t.id}
              className={`nav-item${t.id === tab ? ' active' : ''}`}
              aria-current={t.id === tab ? 'page' : undefined}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
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
