import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { api, ApiError } from '../api.ts';
import { Button, Icon, Input, Notice } from '../ui/index.tsx';
import { OnboardingCard } from '../onboarding/OnboardingCard.tsx';

/**
 * A sign-in refusal an operator can act on.
 *
 * The route is Better Auth's, and its bad-credential answer is
 * `401 {message, code}` — not this console's `{error}` shape — so `ApiError`'s
 * message degrades to `HTTP 401`, which is a status code, not a sentence. The
 * two refusals a human can do something about are therefore named here: wrong
 * credentials (retry) and rate limiting (wait). Anything else keeps whatever the
 * server itself said — its `message` first, since that is the human one — because
 * a guess would be worse than the truth. A 403 is deliberately NOT mapped to
 * "wrong password": Better Auth uses it for an untrusted origin, and telling an
 * operator to retype a correct password is the kind of lie this console does not
 * tell.
 */
export function signInError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return 'That email and password do not match an account. Check them and try again.';
    }
    if (err.status === 429) {
      return 'Too many sign-in attempts. Wait a minute and try again.';
    }
    const said = typeof err.body.message === 'string' ? err.body.message.trim() : '';
    const code = typeof err.body.error === 'string' ? err.body.error.trim() : '';
    return said || code || err.message;
  }
  return err instanceof Error ? err.message : 'Sign-in failed';
}

/**
 * The returning operator's door (D1).
 *
 * The shipped bundle had no sign-in page at all: `refresh()` read the 401 from
 * `GET /api/wizard/state` as "this install is empty" and sent every signed-out
 * visitor to *Create the first admin*, which then answered the raw code
 * `already_bootstrapped`. A bootstrapped deployment now lands HERE instead, and
 * this is the only page in the console that posts `/api/auth/sign-in/email` —
 * the same route the e2e suite signs in with, so there is one wire contract.
 *
 * `onDone` is `refresh()` again: the session cookie is now set, so the same
 * probe that chose this screen chooses the app.
 */
export function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleAvailable, setGoogleAvailable] = useState(false);
  useEffect(() => {
    void api.get<{ google: boolean }>('/auth-config').then((c) => setGoogleAvailable(c.google)).catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/auth/sign-in/email', { email, password });
      onDone();
    } catch (err) { setError(signInError(err)); }
    finally { setBusy(false); }
  };

  const continueWithGoogle = async () => {
    setBusy(true); setError(null);
    try {
      const { url } = await api.post<{ url: string }>('/auth/sign-in/social', {
        provider: 'google',
        callbackURL: window.location.origin,
      });
      window.location.href = url;
    } catch (err) {
      setError(signInError(err));
      setBusy(false);
    }
  };

  return (
    <OnboardingCard title="Sign in"
      subtitle="This brain is already set up. Sign in with your own account to reach the console.">
      <form onSubmit={submit} className="space-y-4">
        {/* `autoComplete` stays: password managers key off it. */}
        <Input type="email" placeholder="Email" value={email}
               onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        <Input type="password" placeholder="Password" value={password}
               onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        {error && (
          <Notice tone="danger">
            <Icon glyph={CircleAlert} size={16} />
            <span>{error}</span>
          </Notice>
        )}
        {/* See Bootstrap.tsx: the submit type has to be spelled out. */}
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      {googleAvailable && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" />
          </div>
          <Button variant="secondary" onClick={() => void continueWithGoogle()} disabled={busy}>
            Continue with Google
          </Button>
        </>
      )}
    </OnboardingCard>
  );
}
