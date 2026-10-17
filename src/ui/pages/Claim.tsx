import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Button, Card, Field, Input, Notice, PageTitle } from '../ui/index.tsx';
import { navigate } from '../router.ts';

export function Claim({ token, onDone }: { token: string; onDone: () => void }) {
  const [info, setInfo] = useState<{ email: string; role: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [name, setName] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [say, setSay] = useState<string | null>(null);
  useEffect(() => { api<{ email: string; role: string }>(`/api/claim/${token}`).then(setInfo, () => setInvalid(true)); }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api(`/api/claim/${token}`, { json: { password, name: name || undefined } });
      const j = await api<{ say: string }>('/api/me/join-key', { method: 'POST' });
      setSay(j.say);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'password_too_short' ? 'Use at least 10 characters.' : 'This invite no longer works.');
    }
  }

  if (invalid) return <main className="mx-auto mt-24 max-w-md px-4"><Notice tone="danger">This invite link has expired or was already used. Ask for a new one.</Notice></main>;
  if (!info) return null;
  return (
    <main className="mx-auto mt-24 max-w-xl px-4">
      <PageTitle>Join Mo-brain</PageTitle>
      {say ? (
        <Card title="One more step: connect your agent" subtitle="Paste this to your coding agent. It sets everything up.">
          <pre className="whitespace-pre-wrap break-all rounded bg-bg p-3 text-sm">{say}</pre>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => navigator.clipboard.writeText(say)}>Copy</Button>
            <Button variant="primary" onClick={() => { onDone(); navigate('/pages'); }}>Open the brain</Button>
          </div>
        </Card>
      ) : (
        <Card subtitle={`You were invited as ${info.role} with ${info.email}.`}>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="Your name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Choose a password" hint="At least 10 characters."><Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
            {error && <Notice tone="danger">{error}</Notice>}
            <Button variant="primary" type="submit">Join</Button>
          </form>
        </Card>
      )}
    </main>
  );
}
