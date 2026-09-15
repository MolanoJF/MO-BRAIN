import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { Bootstrap } from './pages/Bootstrap.tsx';
import { Wizard } from './pages/Wizard.tsx';
import { Health } from './pages/Health.tsx';
import { Members } from './pages/Members.tsx';
import { Connection } from './pages/Connection.tsx';
import { Claim } from './pages/Claim.tsx';
import { Access } from './pages/Access.tsx';

type Phase = 'loading' | 'bootstrap' | 'wizard' | 'ready';
type Page = 'health' | 'setup' | 'members' | 'connection' | 'access';

function claimTokenFromPath(): string | null {
  const m = window.location.pathname.match(/^\/claim\/([^/]+)/);
  if (!m?.[1]) return null;
  return decodeURIComponent(m[1]);
}

export function App() {
  const token = claimTokenFromPath();
  const [phase, setPhase] = useState<Phase>('loading');
  const [page, setPage] = useState<Page>('setup');

  const refresh = async () => {
    const { bootstrapped } = await api.get<{ bootstrapped: boolean }>('/bootstrap');
    if (!bootstrapped) return setPhase('bootstrap');
    try {
      const state = await api.get<{ lifecycle: string }>('/wizard/state');
      setPhase(state.lifecycle === 'ready' ? 'ready' : 'wizard');
      if (state.lifecycle === 'ready') setPage('health');
    } catch { setPhase('bootstrap'); }
  };

  useEffect(() => { if (!token) void refresh(); }, []);

  if (token) return <Claim token={token} />;
  if (phase === 'loading') return <div className="p-6 text-muted">Loading…</div>;
  if (phase === 'bootstrap') return <Bootstrap onDone={refresh} />;

  return (
    <div className="flex min-h-screen">
      <nav className="w-[200px] shrink-0 border-r border-subtle p-4">
        <div className="mb-6 font-semibold">brainstand</div>
        <button className="nav-item" onClick={() => setPage('health')}>Health</button>
        <button className="nav-item" onClick={() => setPage('setup')}>Setup</button>
        {phase === 'ready' && (
          <>
            <button className="nav-item" onClick={() => setPage('members')}>Members</button>
            <button className="nav-item" onClick={() => setPage('connection')}>Connection</button>
            <button className="nav-item" onClick={() => setPage('access')}>Access</button>
          </>
        )}
      </nav>
      <main className="flex-1 p-6">
        {page === 'health' && <Health />}
        {page === 'setup' && <Wizard onReady={refresh} />}
        {page === 'members' && <Members />}
        {page === 'connection' && <Connection />}
        {page === 'access' && <Access />}
      </main>
    </div>
  );
}
