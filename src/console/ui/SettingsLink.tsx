import type { ReactNode } from 'react';
import { goTo, routeToPath } from '../router.ts';
import type { SettingsTab } from '../settings/tabs.ts';
import { Link } from './index.tsx';

/**
 * A link to a settings tab. A real `href` keeps middle-click and "copy link"
 * working; a plain left click is intercepted and routed in-app, so the SPA does
 * not reload (which would drop whatever the page held).
 */
export function SettingsLink({ tab, children }: { tab: SettingsTab; children: ReactNode }) {
  const route = { kind: 'settings', tab } as const;
  return (
    <Link
      href={routeToPath(route)}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        goTo(route);
      }}
    >
      {children}
    </Link>
  );
}
