import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { api, ApiError } from '../api.ts';
import { Button, Icon, Input, Notice } from '../ui/index.tsx';
import { OnboardingCard } from '../onboarding/OnboardingCard.tsx';

/**
 * The fresh-install path, and ONLY that. D1: this form used to be the whole of
 * the console's answer to a signed-out visitor, so a returning operator filled it
 * in and got the raw code `already_bootstrapped` back. That refusal is now a
 * ROUTE: `onSignIn` hands them to the sign-in page, which is where a
 * bootstrapped, sessionless visitor belongs.
 */
export function Bootstrap({ onDone, onSignIn }: { onDone: () => void; onSignIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const [googleSession, setGoogleSession] = useState<{ email: string } | null>(null);

  useEffect(() => {
    void api.get<{ google: boolean }>('/auth-config').then((c) => setGoogleAvailable(c.google)).catch(() => {});
    void api.get<{ user?: { email?: string } } | null>('/auth/get-session')
      .then((s) => setGoogleSession(s?.user?.email ? { email: s.user.email } : null))
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/bootstrap', orgName.trim() ? { email, password, orgName } : { email, password });
      await api.post('/auth/sign-in/email', { email, password });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.body.error === 'already_bootstrapped') return onSignIn();
      setError(err instanceof Error ? err.message : 'Bootstrap failed');
    }
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
      setError(err instanceof Error ? err.message : 'Sign-in failed');
      setBusy(false);
    }
  };

  // A session already exists (the operator just came back from Google) — the
  // org-name-only submit, distinct from the full email/password form below.
  const submitForSession = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/bootstrap', { orgName });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.body.error === 'already_bootstrapped') return onSignIn();
      setError(err instanceof Error ? err.message : 'Bootstrap failed');
    }
    finally { setBusy(false); }
  };

  if (googleSession) {
    return (
      <OnboardingCard step={1} title="Name this brain's organization"
        subtitle={`Signed in as ${googleSession.email}. This name is shown to everyone you invite later.`}>
        <form onSubmit={submitForSession} className="space-y-4">
          <Input placeholder="Organization name" value={orgName}
                 onChange={(e) => setOrgName(e.target.value)} required />
          {error && (
            <Notice tone="danger">
              <Icon glyph={CircleAlert} size={16} />
              <span>{error}</span>
            </Notice>
          )}
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create organization'}
          </Button>
        </form>
      </OnboardingCard>
    );
  }

  return (
    <OnboardingCard step={1} title="Create your account"
      subtitle="This sets up your own private brain. You can turn it into a company brain later in Settings.">
      <form onSubmit={submit} className="space-y-4">
        {/* `Input`, not `Field`: these controls have only ever had placeholders. */}
        <Input placeholder="Name your brain (optional)" value={orgName}
               onChange={(e) => setOrgName(e.target.value)} />
        <Input type="email" placeholder="Email" value={email}
               onChange={(e) => setEmail(e.target.value)} required />
        <Input type="password" placeholder="Password (8+ characters)"
               value={password} onChange={(e) => setPassword(e.target.value)}
               minLength={8} required />
        {error && (
          <Notice tone="danger">
            <Icon glyph={CircleAlert} size={16} />
            <span>{error}</span>
          </Notice>
        )}
        {/* `Button` defaults to type="button"; the submit must be spelled out. */}
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
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
