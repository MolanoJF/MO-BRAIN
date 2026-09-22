import { useEffect, useState } from 'react';
import { Power, Settings } from 'lucide-react';
import { sessionApi } from '../api.ts';
import { Icon } from '../ui/index.tsx';

/**
 * The sidebar's account row: the signed-in email (truncated, never wrapped —
 * `.account-email` handles that in CSS) and two controls, a settings gear and
 * sign-out. The console has had no sign-out until now; an account box that
 * names the signed-in email with no way to leave it would be a conspicuous
 * hole, so this component owns it directly rather than leaving it to a
 * caller that might never add one.
 *
 * The two glyphs were literal `⚙` and `⏻` characters, which is a font
 * dependency dressed up as a drawing: the console picks up whatever those
 * codepoints happen to render as on the operator's machine, at whatever
 * weight, and `⏻` in particular is missing from several stock Windows font
 * stacks. They are lucide nodes now, through `Icon`, so their stroke weight
 * matches the 13px control text beside them and is the same on every machine.
 *
 * The buttons keep `.icon-btn` rather than becoming `IconButton`. They are
 * 28px, transparent and borderless by design — two bordered 32px controls in
 * a 48px row is a different account box, and this phase restyles rather than
 * redesigns. See the report: a borderless icon affordance is the one primitive
 * `ui/` does not have.
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
        <Icon glyph={Settings} size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={signOut}
        aria-label="Sign out"
        title="Sign out"
      >
        <Icon glyph={Power} size={16} />
      </button>
    </div>
  );
}
