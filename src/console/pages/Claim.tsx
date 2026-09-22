import { useMemo, useState } from 'react';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { api } from '../api.ts';
import { wiringSnippet } from '../../control/harness.ts';
import { Button, Card, Empty, Icon, Input, Notice } from '../ui/index.tsx';

/**
 * The credential blocks are `<pre>`, and they borrowed `.field` purely for its
 * box — a `<pre>` is not a control and never was. They are spelled out from
 * tokens here instead of run through `fieldClass()`, because `fieldClass()`
 * also sets `text-[length:var(--control-font)]` and these blocks are `text-xs`
 * on purpose: two utilities setting `font-size` in one class string is exactly
 * the collision `ui/classes.ts` forbids, and the loser is decided by the order
 * Tailwind emits, not by the order written here.
 */
const CREDENTIAL_BLOCK =
  'w-full rounded-[var(--control-radius)] border border-border bg-surface ' +
  'px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap';

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
  const [result, setResult] = useState<{ membershipId: string; connections: ClaimConnection[] } | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ membershipId: string; connections: ClaimConnection[] }>(
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
        <Notice tone="warning">
          <Icon glyph={TriangleAlert} size={16} />
          <p className="m-0 font-medium">
            Credentials are shown once and are not recoverable. Save them now.
          </p>
        </Notice>
        {result.connections.length === 0 && (
          <Empty>No pending connections were provisioned for this member.</Empty>
        )}
        {result.connections.map((conn) => (
          <ClaimedConnection key={conn.connectionId} conn={conn} />
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
      <Input type="email" placeholder="Email" value={email}
             onChange={(e) => setEmail(e.target.value)} />
      {error && (
        <Notice tone="danger">
          <Icon glyph={CircleAlert} size={16} />
          {/* All three sentences stay, in this order. The second and third are
              the only thing standing between an operator and a burned link
              they cannot get back. */}
          <div className="space-y-1">
            <p className="m-0">{error}</p>
            {burned && <p className="m-0">This link is burned. Credentials are not recoverable — ask an admin for a new claim link.</p>}
            {wrongEmail && <p className="m-0">Wrong email. The link was not consumed; try the address the invite was sent to.</p>}
          </div>
        </Notice>
      )}
      {/* Not inside a `<form>` — this one always drove off `onClick`, so it
          keeps `Button`'s `type="button"` default. */}
      <Button variant="primary" disabled={busy || !email} onClick={() => void submit()}>
        {busy ? 'Claiming…' : 'Claim'}
      </Button>
    </div>
  );
}

function ClaimedConnection({ conn }: { conn: ClaimConnection }) {
  const creds = asCreds(conn.credentials);
  const snippet = useMemo(() => {
    try {
      return wiringSnippet(conn.harness, { client_id: creds.client_id, mcp_url: conn.mcp_url });
    } catch (e) {
      return e instanceof Error ? e.message : 'unknown harness';
    }
  }, [conn.harness, conn.mcp_url, creds.client_id]);

  return (
    // The connection id was an `<h2 className="font-mono">`; `Card`'s `title`
    // is a ReactNode rendered inside its own `<h2>`, so the monospace moves
    // onto a span rather than being lost or fought over.
    <Card title={<span className="font-mono">{conn.connectionId}</span>} className="space-y-3">
      <pre className={CREDENTIAL_BLOCK}>
        {JSON.stringify(conn.credentials, null, 2)}
      </pre>
      <dl className="space-y-1 text-sm font-mono">
        {creds.client_id != null && <div>client_id: {creds.client_id}</div>}
        {creds.client_secret != null && <div>client_secret: {creds.client_secret}</div>}
        <div>harness: {conn.harness}</div>
        <div>mcp_url: {conn.mcp_url}</div>
      </dl>
      <pre className={CREDENTIAL_BLOCK}>{snippet}</pre>
    </Card>
  );
}
