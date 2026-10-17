import { useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Button, Card, Field, Input, Notice, PageTitle } from '../ui/index.tsx';

export function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api('/api/auth/login', { json: { email, password } }); onDone(); }
    catch (err) { setError(err instanceof ApiError && err.code === 'too_many_attempts' ? 'Too many attempts. Wait 15 minutes.' : 'Email or password is wrong.'); }
    finally { setBusy(false); }
  }
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <PageTitle>Mo-brain</PageTitle>
      <Card>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label="Email"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          {error && <Notice tone="danger">{error}</Notice>}
          <Button variant="primary" type="submit" disabled={busy}>Sign in</Button>
        </form>
      </Card>
      <p className="mt-3 text-sm text-muted">Forgot it? Ask your agent to run <code>mobrain</code>'s password reset on the brain host.</p>
    </main>
  );
}
