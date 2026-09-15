import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { Bootstrap } from './pages/Bootstrap.tsx';
import { Wizard } from './pages/Wizard.tsx';
import { Health } from './pages/Health.tsx';

type Phase = 'loading' | 'bootstrap' | 'wizard' | 'ready';

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [page, setPage] = useState<'health' | 'setup'>('setup');

  const refresh = async () => {
    const { bootstrapped } = await api.get<{ bootstrapped: boolean }>('/bootstrap');
    if (!bootstrapped) return setPhase('bootstrap');
    try {
      const state = await api.get<{ lifecycle: string }>('/wizard/state');
      setPhase(state.lifecycle === 'ready' ? 'ready' : 'wizard');
      if (state.lifecycle === 'ready') setPage('health');
    } catch { setPhase('bootstrap'); }
  };

  useEffect(() => { void refresh(); }, []);

  if (phase === 'loading') return <div className="p-6 text-muted">Loading…</div>;
  if (phase === 'bootstrap') return <Bootstrap onDone={refresh} />;

  return (
    <div className="flex min-h-screen">
      <nav className="w-[200px] shrink-0 border-r border-subtle p-4">
        <div className="mb-6 font-semibold">brainstand</div>
        <button className="nav-item" onClick={() => setPage('health')}>Health</button>
        <button className="nav-item" onClick={() => setPage('setup')}>Setup</button>
      </nav>
      <main className="flex-1 p-6">
        {page === 'health' ? <Health /> : <Wizard onReady={refresh} />}
      </main>
    </div>
  );
}
