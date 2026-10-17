import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api.ts';
import { navigate, usePath } from './router.ts';
import { Shell } from './Shell.tsx';
import { Login } from './pages/Login.tsx';
import { Claim } from './pages/Claim.tsx';
import { Pages } from './pages/Pages.tsx';
import { Sources } from './pages/Sources.tsx';
import { Schema } from './pages/Schema.tsx';
import { Activity } from './pages/Activity.tsx';
import { Health } from './pages/Health.tsx';
import { People } from './pages/People.tsx';
import { Connect } from './pages/Connect.tsx';
import { Spinner } from './ui/index.tsx';

export function App() {
  const path = usePath();
  const [me, setMe] = useState<Me | null | 'anon'>(null);
  const load = useCallback(() => {
    api<Me>('/api/me').then(setMe, (e) => setMe(e instanceof ApiError && e.status === 401 ? 'anon' : 'anon'));
  }, []);
  useEffect(load, [load]);

  const claim = /^\/claim\/([^/]+)$/.exec(path);
  if (claim) return <Claim token={claim[1]!} onDone={load} />;
  if (me === null) return <div className="p-6"><Spinner /></div>;
  if (me === 'anon') return <Login onDone={load} />;
  if (path === '/' || path === '/login') { navigate('/pages'); return null; }

  const admin = me.user.role === 'owner' || me.user.role === 'admin';
  let page: React.ReactNode;
  if (path.startsWith('/pages')) page = <Pages me={me} path={path} />;
  else if (path === '/sources') page = <Sources me={me} />;
  else if (path === '/schema') page = <Schema />;
  else if (path === '/activity' && admin) page = <Activity />;
  else if (path === '/health' && admin) page = <Health />;
  else if (path === '/people' && admin) page = <People me={me} onChange={load} />;
  else if (path === '/connect') page = <Connect me={me} onChange={load} />;
  else page = <p className="text-muted">Not found.</p>;
  return <Shell me={me} path={path}>{page}</Shell>;
}
