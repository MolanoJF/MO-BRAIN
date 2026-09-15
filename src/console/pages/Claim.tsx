import { useMemo, useState } from 'react';
import { api } from '../api.ts';
import { HARVEST_MAP, wiringSnippet } from '../../control/harness.ts';

type ClaimConnection = { connectionId: string; credentials: unknown };

type Creds = {
  client_id?: string;
  client_secret?: string;
  mcp_url?: string;
  url?: string;
  harness?: string;
};

const HARNESS_IDS = Object.keys(HARVEST_MAP);

function asCreds(raw: unknown): Creds {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Creds;
  return {};
}

function mcpUrl(creds: Creds): string {
  if (typeof creds.mcp_url === 'string' && creds.mcp_url) return creds.mcp_url;
  if (typeof creds.url === 'string' && creds.url) return creds.url;
  return `${window.location.origin}/mcp`;
}

function defaultHarness(creds: Creds): string {
  if (creds.harness && creds.harness in HARVEST_MAP) return creds.harness;
  return 'generic';
}

export function Claim({ token }: { token: string }) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ membershipId: string; connections: ClaimConnection[] } | null>(null);
  const [harnessById, setHarnessById] = useState<Record<string, string>>({});

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ membershipId: string; connections: ClaimConnection[] }>(
        `/claim/${token}`,
        { email },
      );
      setResult(r);
      const next: Record<string, string> = {};
      for (const conn of r.connections) {
        next[conn.connectionId] = defaultHarness(asCreds(conn.credentials));
      }
      setHarnessById(next);
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
          <ClaimedConnection
            key={conn.connectionId}
            conn={conn}
            harness={harnessById[conn.connectionId] ?? 'generic'}
            onHarness={(id) => setHarnessById((prev) => ({ ...prev, [conn.connectionId]: id }))}
          />
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

function ClaimedConnection({
  conn, harness, onHarness,
}: {
  conn: ClaimConnection;
  harness: string;
  onHarness: (id: string) => void;
}) {
  const creds = asCreds(conn.credentials);
  const url = mcpUrl(creds);
  const snippet = useMemo(
    () => wiringSnippet(harness, { client_id: creds.client_id, mcp_url: url }),
    [harness, creds.client_id, url],
  );

  return (
    <section className="card space-y-3">
      <h2 className="font-medium font-mono text-sm">{conn.connectionId}</h2>
      <pre className="field font-mono text-xs whitespace-pre-wrap">
        {JSON.stringify(conn.credentials, null, 2)}
      </pre>
      <dl className="space-y-1 text-sm font-mono">
        {creds.client_id != null && <div>client_id: {creds.client_id}</div>}
        {creds.client_secret != null && <div>client_secret: {creds.client_secret}</div>}
        <div>mcp_url: {url}</div>
      </dl>
      <label className="text-sm">
        Harness
        <select className="field mt-1" value={harness} onChange={(e) => onHarness(e.target.value)}>
          {HARNESS_IDS.map((id) => (
            <option key={id} value={id}>{id} ({HARVEST_MAP[id] ?? 'unknown'})</option>
          ))}
        </select>
      </label>
      <pre className="field font-mono text-xs whitespace-pre-wrap">{snippet}</pre>
    </section>
  );
}
