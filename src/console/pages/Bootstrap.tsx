import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { api, ApiError } from '../api.ts';
import { Button, Icon, Input, Notice, PageTitle } from '../ui/index.tsx';

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
      <form onSubmit={submitForSession} className="mx-auto mt-16 max-w-md space-y-4 p-6">
        <PageTitle>Name this brain&apos;s organization</PageTitle>
        <p className="text-sm text-muted">
          Signed in as {googleSession.email}. This name is shown to everyone you invite later.
        </p>
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
    );
  }

  return (
    <div className="mx-auto mt-16 max-w-md space-y-4 p-6">
      <form onSubmit={submit} className="space-y-4">
        <PageTitle>Create your account</PageTitle>
        <p className="text-sm text-muted">
          This sets up your own private brain. You can turn it into a company brain later in Settings.
        </p>
        {/* `Input`, not `Field`. `Field` renders a visible `<label>`, and these
            three controls have only ever had placeholders; writing label text
            for them would be new copy, and this phase changes none. */}
        <Input placeholder="Name your brain (optional)" value={orgName}
               onChange={(e) => setOrgName(e.target.value)} />
        <Input type="email" placeholder="Email" value={email}
               onChange={(e) => setEmail(e.target.value)} required />
        <Input type="password" placeholder="Password (12+ characters)"
               value={password} onChange={(e) => setPassword(e.target.value)}
               minLength={12} required />
        {error && (
          <Notice tone="danger">
            <Icon glyph={CircleAlert} size={16} />
            <span>{error}</span>
          </Notice>
        )}
        {/* `type="submit"` is not decoration. This button was a bare `<button>`
            inside a `<form>`, where the implicit type IS submit; `Button`
            defaults to `type="button"` so that a control in a table row cannot
            submit a form it happens to sit in. Without this the form would stop
            submitting — on click AND on Enter in any field. */}
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </Button>
      </form>
      {googleAvailable && (
        <>
          <div className="text-center text-xs text-muted">or</div>
          <Button variant="secondary" onClick={() => void continueWithGoogle()} disabled={busy}>
            Continue with Google
          </Button>
        </>
      )}
    </div>
  );
}
