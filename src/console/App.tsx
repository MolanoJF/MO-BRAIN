import { useEffect, useState } from 'react';
import { api, ApiError } from './api.ts';
import { PRODUCT_NAME } from '../control/lifecycle.ts';
import { Bootstrap } from './pages/Bootstrap.tsx';
import { SignIn } from './pages/SignIn.tsx';
import { Wizard } from './pages/Wizard.tsx';
import { Health } from './pages/Health.tsx';
import { Members } from './pages/Members.tsx';
import { Connection } from './pages/Connection.tsx';
import { Claim } from './pages/Claim.tsx';
import { Access } from './pages/Access.tsx';
import { Schedules } from './pages/Schedules.tsx';
import { Runs } from './pages/Runs.tsx';
import { Spend } from './pages/Spend.tsx';
import { Upgrades } from './pages/Upgrades.tsx';
import { Files } from './pages/Files.tsx';
import { Schema } from './pages/Schema.tsx';

type Phase = 'loading' | 'bootstrap' | 'signin' | 'wizard' | 'ready';
type Page = 'health' | 'setup' | 'members' | 'connection' | 'access' | 'schedules' | 'runs' | 'spend' | 'upgrades' | 'files' | 'schema';

/**
 * What `GET /api/wizard/state` answered, as the screen chooser sees it: an HTTP
 * status, or nothing at all. The lifecycle is only present when the route said
 * something, which is why it is optional rather than `null`.
 */
export type WizardProbe = { status: number; lifecycle?: string | null } | { status: 'unreachable' };

/**
 * The screen a `refresh()` observation selects. **The discriminator is
 * `GET /api/bootstrap`'s `{bootstrapped}`, not the 401 from
 * `GET /api/wizard/state`** — D1: that 401 (a bootstrapped deployment, no
 * session) used to fall into `catch { setPhase('bootstrap') }`, so every
 * returning operator was shown *Create the first admin* and the shipped bundle
 * had no sign-in page at all.
 *
 *   401  no session                -> the sign-in page
 *   403  a session, not an admin    -> the app: only an authenticated caller can
 *        be refused by role, and the wizard is admin-only, so its lifecycle is
 *        not this operator's to read. Sending them to sign in would loop.
 *   2xx  a session                  -> the app, or the wizard while setup is unfinished
 *   anything else (5xx, unreachable) -> the sign-in page: `bootstrapped` has
 *        already said this is not a fresh install, and the sign-in page surfaces
 *        its own failure instead of claiming the install is empty.
 */
export function phaseFor(bootstrapped: boolean, probe: WizardProbe): Phase {
  if (!bootstrapped) return 'bootstrap';
  if (probe.status === 'unreachable' || probe.status === 401) return 'signin';
  if (probe.status === 403) return 'ready';
  if (probe.status >= 200 && probe.status < 300) {
    return probe.lifecycle === 'ready' ? 'ready' : 'wizard';
  }
  return 'signin';
}

/**
 * The SPA's only real routes. Everything else is a page switch, but a schedule
 * alert (or an upgrade banner) arrives as a link, so `/schedules` and
 * `/upgrades` have to survive a cold load.
 */
function pageFromPath(): Page | null {
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === '/schedules') return 'schedules';
  if (path === '/runs') return 'runs';
  if (path === '/spend') return 'spend';
  if (path === '/upgrades') return 'upgrades';
  if (path === '/files') return 'files';
  return null;
}

function claimTokenFromPath(): string | null {
  const m = window.location.pathname.match(/^\/claim\/([^/]+)/);
  if (!m?.[1]) return null;
  return decodeURIComponent(m[1]);
}

export function App() {
  const token = claimTokenFromPath();
  const requested = pageFromPath();
  const [phase, setPhase] = useState<Phase>('loading');
  const [page, setPage] = useState<Page>(requested ?? 'setup');

  const refresh = async () => {
    const { bootstrapped } = await api.get<{ bootstrapped: boolean }>('/bootstrap');
    if (!bootstrapped) return setPhase('bootstrap');
    // The 401 this catches is "not signed in", and only that: a 403 means the
    // opposite (a session, without the role), and the two must not be conflated.
    let probe: WizardProbe;
    try {
      const state = await api.get<{ lifecycle: string }>('/wizard/state');
      probe = { status: 200, lifecycle: state.lifecycle };
    } catch (err) {
      probe = err instanceof ApiError ? { status: err.status } : { status: 'unreachable' };
    }
    const next = phaseFor(bootstrapped, probe);
    setPhase(next);
    if (next === 'ready') {
      // Never clobber a page the operator asked for by URL.
      setPage((current) => (current === 'setup' ? (requested ?? 'health') : current));
    }
  };

  useEffect(() => { if (!token) void refresh(); }, []);

  if (token) return <Claim token={token} />;
  if (phase === 'loading') return <div className="p-6 text-muted">Loading…</div>;
  if (phase === 'bootstrap') {
    // A non-fresh install has to be able to LEAVE this form: `already_bootstrapped`
    // sends the operator to sign-in rather than printing the code (D1).
    return <Bootstrap onDone={refresh} onSignIn={() => setPhase('signin')} />;
  }
  if (phase === 'signin') return <SignIn onDone={refresh} />;

  return (
    <div className="flex min-h-screen">
      <nav className="w-[200px] shrink-0 border-r border-subtle p-4">
        <div className="mb-6 font-semibold">{PRODUCT_NAME}</div>
        <button className="nav-item" onClick={() => setPage('health')}>Health</button>
        <button className="nav-item" onClick={() => setPage('setup')}>Setup</button>
        {phase === 'ready' && (
          <>
            <button className="nav-item" onClick={() => setPage('files')}>Files</button>
            <button className="nav-item" onClick={() => setPage('members')}>Members</button>
            <button className="nav-item" onClick={() => setPage('connection')}>Connection</button>
            <button className="nav-item" onClick={() => setPage('schema')}>Schema</button>
            <button className="nav-item" onClick={() => setPage('schedules')}>Schedules</button>
            <button className="nav-item" onClick={() => setPage('runs')}>Runs</button>
            <button className="nav-item" onClick={() => setPage('spend')}>Spend</button>
            <button className="nav-item" onClick={() => setPage('upgrades')}>Upgrades</button>
            <button className="nav-item" onClick={() => setPage('access')}>Access</button>
          </>
        )}
      </nav>
      <main className="flex-1 p-6">
        {page === 'health' && <Health />}
        {page === 'setup' && <Wizard onReady={refresh} />}
        {page === 'members' && <Members />}
        {page === 'connection' && <Connection />}
        {page === 'schema' && <Schema />}
        {page === 'schedules' && <Schedules />}
        {page === 'runs' && <Runs />}
        {page === 'spend' && <Spend />}
        {page === 'upgrades' && <Upgrades />}
        {page === 'access' && <Access />}
        {page === 'files' && <Files />}
      </main>
    </div>
  );
}
