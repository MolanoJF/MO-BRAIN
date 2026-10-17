import type { ReactNode } from 'react';
import { api, type Me } from './api.ts';
import { navFor } from './lib.ts';
import { navigate } from './router.ts';
import { NavItem } from './ui/index.tsx';
import { setTheme, storedTheme } from './theme.ts';

export function Shell({ me, path, children }: { me: Me; path: string; children: ReactNode }) {
  const nav = navFor(me.user.role, me.mode);
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-[var(--sidebar-w)] shrink-0 flex-col border-r border-border bg-surface p-3">
        <div className="px-2 py-3 text-lg font-semibold">Mo-brain</div>
        <nav className="flex flex-col gap-1">
          {nav.map((n) => <NavItem key={n.path} active={path.startsWith(n.path)} onClick={() => navigate(n.path)}>{n.label}</NavItem>)}
        </nav>
        <div className="mt-auto flex flex-col gap-1 border-t border-border pt-3 text-sm">
          <div className="truncate px-2 text-muted" title={me.user.email}>{me.user.email} · {me.user.role}</div>
          <NavItem onClick={() => setTheme(storedTheme() === 'dark' ? 'light' : 'dark')}>Toggle theme</NavItem>
          <NavItem onClick={async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; }}>Sign out</NavItem>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6">{children}</main>
    </div>
  );
}
