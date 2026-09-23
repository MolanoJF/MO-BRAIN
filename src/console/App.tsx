import { useEffect, useState } from 'react';
import { api, ApiError } from './api.ts';
import { Bootstrap } from './pages/Bootstrap.tsx';
import { SignIn } from './pages/SignIn.tsx';
import { NoAccess } from './pages/NoAccess.tsx';
import { Wizard } from './pages/Wizard.tsx';
import { Claim } from './pages/Claim.tsx';
import { legacyRedirect } from './router.ts';
import { AppShell } from './AppShell.tsx';
import { OrgProvider } from './OrgContext.tsx';

type Phase = 'loading' | 'bootstrap' | 'signin' | 'noAccess' | 'wizard' | 'ready';

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
 *   403 from /wizard/state + no membership at all -> 'noAccess' (D5): a
 *     real session (Google or otherwise) that isn't a member of any org.
 *     A 403 WITH a membership (wrong role for the admin-only wizard) still
 *     reads as 'ready', exactly as before.
 */
export function phaseFor(bootstrapped: boolean, probe: WizardProbe, hasMembership: boolean): Phase {
  if (!bootstrapped) return 'bootstrap';
  if (probe.status === 'unreachable' || probe.status === 401) return 'signin';
  if (probe.status === 403) return hasMembership ? 'ready' : 'noAccess';
  if (probe.status >= 200 && probe.status < 300) {
    return probe.lifecycle === 'ready' ? 'ready' : 'wizard';
  }
  return 'signin';
}

/**
 * A 403 from the admin-only wizard probe is a SESSION WITHOUT THE ADMIN ROLE —
 * the console's only role signal. `phaseFor` already draws this exact line:
 * a 403 reaches `ready` (a valid session, refused only by role) while
 * everything else that is not a clean 2xx does not. `isAdminFrom` reads the
 * same probe for the shell's `isAdmin` prop, which gates which settings tabs
 * `resolveTab`/`visibleTabs` show. Only a clean 2xx (the probe succeeding,
 * meaning the caller *is* allowed past the admin-only endpoint) counts;
 * every refusal or failure — 403, 401, 5xx, unreachable — reads as "not
 * admin", never as "admin, but we couldn't check."
 */
export function isAdminFrom(probe: WizardProbe): boolean {
  return probe.status !== 'unreachable' && probe.status >= 200 && probe.status < 300;
}

function claimTokenFromPath(): string | null {
  const m = window.location.pathname.match(/^\/claim\/([^/]+)/);
  if (!m?.[1]) return null;
  return decodeURIComponent(m[1]);
}

// A live bookmark to a pre-shell URL (`/sources`, `/schedules`, `/runs`,
// `/spend`, `/upgrades`, `/files`) has to survive this rewrite. This runs
// once, before the first route is parsed anywhere downstream (`AppShell`'s
// `useRoute()`), so the very first paint already sees the rewritten path
// rather than a route that `parseRoute` would otherwise fall back to '/'.
// Guarded on `window` existing: this module is imported by
// `test/unit/console-app.test.ts`, which runs under bun's test runner with
// no DOM (this repo has no happy-dom/jsdom), so top-level module code can
// never assume `window` is present.
if (typeof window !== 'undefined') {
  const redirected = legacyRedirect(window.location.pathname);
  if (redirected !== null) {
    window.history.replaceState(null, '', redirected);
  }
}

export function App() {
  const token = claimTokenFromPath();
  const [phase, setPhase] = useState<Phase>('loading');
  const [isAdmin, setIsAdmin] = useState(false);
  const [noAccessEmail, setNoAccessEmail] = useState('');

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
    let hasMembership = false;
    if (probe.status === 403) {
      const me = await api.get<{ email: string; hasMembership: boolean }>('/me').catch(() => null);
      hasMembership = me?.hasMembership ?? false;
      setNoAccessEmail(me?.email ?? '');
    }
    setPhase(phaseFor(bootstrapped, probe, hasMembership));
    setIsAdmin(isAdminFrom(probe));
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
  if (phase === 'noAccess') return <NoAccess email={noAccessEmail} />;
  if (phase === 'wizard') {
    // A full-screen takeover, not a tab inside the shell: a brain that is
    // not `ready` has no Sources and no files, so the shell's editor would
    // just be an empty frame around a Source switcher with nothing to switch.
    return <Wizard onReady={refresh} />;
  }

  return <OrgProvider><AppShell isAdmin={isAdmin} /></OrgProvider>;
}
