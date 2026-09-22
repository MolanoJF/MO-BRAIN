import { useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { api, ApiError } from '../api.ts';
import { Button, Icon, Input, Notice } from '../ui/index.tsx';

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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/bootstrap', { email, password, orgName });
      await api.post('/auth/sign-in/email', { email, password });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.body.error === 'already_bootstrapped') return onSignIn();
      setError(err instanceof Error ? err.message : 'Bootstrap failed');
    }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="mx-auto mt-16 max-w-md space-y-4 p-6">
      <h1 className="text-xl font-semibold">Create the first admin</h1>
      <p className="text-sm text-muted">
        This account owns the brain. Nobody else can be created until setup finishes.
      </p>
      {/* `Input`, not `Field`. `Field` renders a visible `<label>`, and these
          three controls have only ever had placeholders; writing label text
          for them would be new copy, and this phase changes none. */}
      <Input placeholder="Organization name" value={orgName}
             onChange={(e) => setOrgName(e.target.value)} required />
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
        {busy ? 'Creating…' : 'Create admin'}
      </Button>
    </form>
  );
}
