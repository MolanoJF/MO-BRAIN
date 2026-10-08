import { useMemo, useState } from 'react';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { api } from '../api.ts';
import { wiringSnippet } from '../../control/harness.ts';
import { Button, Card, Icon, Input, Notice, PageTitle } from '../ui/index.tsx';

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
  verify: { status: string | null; message: string | null } | null;
};

type Creds = {
  client_id?: string;
  client_secret?: string;
  access_token?: string;
};

function asCreds(raw: unknown): Creds {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Creds;
  return {};
}

/** Better Auth's default `maxPasswordLength`. The server re-checks before burning the link. */
export const CLAIM_PASSWORD_MAX = 128;

/**
 * Trim + lowercase, the same address `claim` stores. The claim post and the
 * sign-in post both go through this so a pasted space cannot miss the account.
 */
export function normalizeClaimEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Client-side mirror of the server's rule; the server re-checks before burning the link. */
export function claimFormError(password: string, confirm: string): string | null {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > CLAIM_PASSWORD_MAX) return `Use at most ${CLAIM_PASSWORD_MAX} characters.`;
  if (password !== confirm) return 'Passwords do not match.';
  return null;
}

export function Claim({ token }: { token: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [signInNotice, setSignInNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ membershipId: string; connections: ClaimConnection[]; skillsPublished: boolean; account: 'created' | 'existing' | 'unchanged' } | null>(null);
  const formError = claimFormError(password, confirm);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ membershipId: string; connections: ClaimConnection[]; skillsPublished: boolean; account: 'created' | 'existing' | 'unchanged' }>(
        `/claim/${token}`,
        { email: normalizeClaimEmail(email), password },
      );
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setBusy(false);
    }
  };

  const enter = async () => {
    if (result?.account !== 'created') {
      window.location.assign('/');
      return;
    }
    try {
      await api.post('/auth/sign-in/email', { email: normalizeClaimEmail(email), password });
      window.location.assign('/');
    } catch {
      // Any refusal, not only a bad address. The password is already set; do not log it.
      setSignInNotice(
        'Sign-in from this page failed. You can sign in with that password from the sign-in page.',
      );
    }
  };

  const burned = error?.toLowerCase().includes('already used') ?? false;
  const wrongEmail = error?.toLowerCase().includes('email does not match') ?? false;

  if (result) {
    return (
      <div className="mx-auto mt-16 max-w-2xl space-y-6 p-6">
        <PageTitle>You're in</PageTitle>
        {result.account === 'existing' && (
          <Notice>You already had an account with this email. Sign in with your existing password.</Notice>
        )}
        {signInNotice && <Notice>{signInNotice}</Notice>}
        <Button variant="primary" onClick={() => void enter()}>
          {result.account === 'created' ? 'Open your brain' : 'Go to sign in'}
        </Button>
        {result.connections.length > 0 && (
          <>
            <Notice tone="warning">
              <Icon glyph={TriangleAlert} size={16} />
              <p className="m-0 font-medium">
                Credentials are shown once and are not recoverable. Save them now.
              </p>
            </Notice>
            {result.connections.map((conn) => (
              <ClaimedConnection key={conn.connectionId} conn={conn} skills={result.skillsPublished} />
            ))}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 max-w-md space-y-4 p-6">
      <PageTitle>Create your account</PageTitle>
      <p className="text-sm text-muted">
        You've been invited to a company brain. You'll get your own private Source that only you can see,
        plus access to the company Sources your admin shares with you.
      </p>
      <Input type="email" placeholder="The email this invite was sent to" value={email}
             onChange={(e) => setEmail(e.target.value)} />
      <Input type="password" placeholder="Choose a password (12+ characters)" value={password}
             onChange={(e) => setPassword(e.target.value)} />
      <Input type="password" placeholder="Confirm password" value={confirm}
             onChange={(e) => setConfirm(e.target.value)} />
      {password.length > 0 && formError && (
        <p className="text-sm text-muted">{formError}</p>
      )}
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
      <Button variant="primary" disabled={busy || !email || formError !== null} onClick={() => void submit()}>
        {busy ? 'Creating…' : 'Create account'}
      </Button>
    </div>
  );
}

function ClaimedConnection({ conn, skills }: { conn: ClaimConnection; skills: boolean }) {
  const creds = asCreds(conn.credentials);
  const { snippet, agentInstructions } = useMemo(() => {
    try {
      return wiringSnippet(conn.harness, {
        client_id: creds.client_id, access_token: creds.access_token, mcp_url: conn.mcp_url,
      }, { skills });
    } catch (e) {
      return { snippet: e instanceof Error ? e.message : 'unknown harness', agentInstructions: null };
    }
  }, [conn.harness, conn.mcp_url, creds.client_id, creds.access_token, skills]);

  const verifyLine = conn.verify?.status === 'ok'
    ? 'Verified: this connection authenticated successfully.'
    : conn.verify?.status === 'partial'
    ? 'Server checks passed. (A full end-to-end check requires the connected agent to actually make a request, which isn\'t run automatically to avoid extra cost.)'
    : conn.verify?.status === 'failed'
    ? `Verify failed${conn.verify.message ? `: ${conn.verify.message}` : '.'}`
    : null;

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
      {verifyLine && (
        <Notice
          tone={
            conn.verify?.status === 'ok' ? 'ok' : conn.verify?.status === 'failed' ? 'danger' : 'warning'
          }
        >
          {verifyLine}
        </Notice>
      )}
      {agentInstructions && (
        <div className="space-y-1">
          <h3 className="m-0 text-sm font-medium">Agent instructions</h3>
          <pre className={CREDENTIAL_BLOCK}>{agentInstructions}</pre>
        </div>
      )}
    </Card>
  );
}
