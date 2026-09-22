import { useEffect, useState } from 'react';
import { sessionApi } from '../api.ts';

/**
 * The sidebar's account row: the signed-in email (truncated, never wrapped —
 * `.account-email` handles that in CSS) and two controls, a settings gear and
 * sign-out. The console has had no sign-out until now; an account box that
 * names the signed-in email with no way to leave it would be a conspicuous
 * hole, so this component owns it directly rather than leaving it to a
 * caller that might never add one.
 */
export function AccountBox({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void sessionApi.me().then((user) => {
      if (!cancelled) setEmail(user?.email ?? null);
    });
    return () => { cancelled = true; };
  }, []);

  const signOut = () => {
    void sessionApi.signOut().finally(() => {
      // The session cookie is gone and every cached page is stale — a full
      // reload is the honest response, not an attempt to unwind React state.
      window.location.assign('/');
    });
  };

  return (
    <div className="account-box">
      <span className="account-email">{email ?? ''}</span>
      <button
        type="button"
        className="icon-btn"
        onClick={onOpenSettings}
        aria-label="Settings"
        title="Settings"
      >
        ⚙
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={signOut}
        aria-label="Sign out"
        title="Sign out"
      >
        ⏻
      </button>
    </div>
  );
}
