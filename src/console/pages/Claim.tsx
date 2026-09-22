import { useMemo, useState } from 'react';
import { api } from '../api.ts';
import { wiringSnippet } from '../../control/harness.ts';

type ClaimConnection = {
  connectionId: string;
  credentials: unknown;
  harness: string;
  mcp_url: string;
};

type Creds = {
  client_id?: string;
  client_secret?: string;
};

function asCreds(raw: unknown): Creds {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Creds;
  return {};
}

export function Claim({ token }: { token: string }) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ membershipId: string; connections: ClaimConnection[]; skillsPublished: boolean } | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ membershipId: string; connections: ClaimConnection[]; skillsPublished: boolean }>(
        `/claim/${token}`,
        { email },
      );
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setBusy(false);
    }
  };

  const burned = error?.toLowerCase().includes('already used') ?? false;
  const wrongEmail = error?.toLowerCase().includes('email does not match') ?? false;

  if (result) {
    return (
      <div className="mx-auto mt-16 max-w-2xl space-y-6 p-6">
        <h1 className="text-xl font-semibold">Claim complete</h1>
        <div className="card border-warning">
          <p className="text-sm font-medium">
            Credentials are shown once and are not recoverable. Save them now.
          </p>
        </div>
        {result.connections.length === 0 && (
          <p className="text-sm text-muted">No pending connections were provisioned for this member.</p>
        )}
        {result.connections.map((conn) => (
          <ClaimedConnection key={conn.connectionId} conn={conn} skills={result.skillsPublished} />
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 max-w-md space-y-4 p-6">
      <h1 className="text-xl font-semibold">Claim your agent credentials</h1>
      <p className="text-sm text-muted">
        Enter the email this invite was issued to. Credentials appear once and cannot be recovered.
      </p>
      <input className="field" type="email" placeholder="Email" value={email}
             onChange={(e) => setEmail(e.target.value)} />
      {error && (
        <div className="text-danger text-sm space-y-1">
          <p>{error}</p>
          {burned && <p>This link is burned. Credentials are not recoverable — ask an admin for a new claim link.</p>}
          {wrongEmail && <p>Wrong email. The link was not consumed; try the address the invite was sent to.</p>}
        </div>
      )}
      <button className="btn-primary" disabled={busy || !email} onClick={() => void submit()}>
        {busy ? 'Claiming…' : 'Claim'}
      </button>
    </div>
  );
}

function ClaimedConnection({ conn, skills }: { conn: ClaimConnection; skills: boolean }) {
  const creds = asCreds(conn.credentials);
  const snippet = useMemo(() => {
    try {
      return wiringSnippet(conn.harness, { client_id: creds.client_id, mcp_url: conn.mcp_url }, { skills });
    } catch (e) {
      return e instanceof Error ? e.message : 'unknown harness';
    }
  }, [conn.harness, conn.mcp_url, creds.client_id, skills]);

  return (
    <section className="card space-y-3">
      <h2 className="font-medium font-mono text-sm">{conn.connectionId}</h2>
      <pre className="field font-mono text-xs whitespace-pre-wrap">
        {JSON.stringify(conn.credentials, null, 2)}
      </pre>
      <dl className="space-y-1 text-sm font-mono">
        {creds.client_id != null && <div>client_id: {creds.client_id}</div>}
        {creds.client_secret != null && <div>client_secret: {creds.client_secret}</div>}
        <div>harness: {conn.harness}</div>
        <div>mcp_url: {conn.mcp_url}</div>
      </dl>
      <pre className="field font-mono text-xs whitespace-pre-wrap">{snippet}</pre>
    </section>
  );
}
