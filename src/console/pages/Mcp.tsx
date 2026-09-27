import { useEffect, useRef, useState } from 'react';
import { ApiError, myMcpApi, type MyMcpConfig } from '../api.ts';
import { Button, Card, Notice } from '../ui/index.tsx';

/** How long a copy button says "Copied" before it returns to "Copy". */
const COPIED_MS = 1200;

const BLOCK =
  'w-full rounded-[var(--control-radius)] border border-border bg-surface ' +
  'px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap break-all';

const REISSUE_COPY =
  'The previous paste stops working. A schedule tied to the old connection is paused.';

const EMPTY = {
  no_private_space: 'You do not have a private Space yet. Ask an admin to retry provisioning it.',
  no_private_connection: 'You do not have a private connection yet, so there is nothing to paste.',
  connection_pending: 'Finish claiming your invite first. A connection that is still pending is not shown.',
  credentials_unavailable: 'This connection was issued before its secret was kept.',
} as const;

export type McpPaste = {
  endpoint: string;
  credentialJson: string;
  snippet: string;
};

/**
 * The three paste strings for a successful `/api/my/mcp` body.
 * A handoff with no `client_secret` is not a config: an empty document
 * would look like something an agent can use.
 */
export function mcpPaste(payload: {
  mcp_url: string;
  credentials: unknown;
  snippet: string;
}): McpPaste | null {
  const { credentials } = payload;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return null;
  const secret = (credentials as { client_secret?: unknown }).client_secret;
  if (typeof secret !== 'string' || secret.trim().length === 0) return null;
  if (typeof payload.mcp_url !== 'string' || payload.mcp_url.length === 0) return null;
  if (typeof payload.snippet !== 'string' || payload.snippet.length === 0) return null;
  return {
    endpoint: payload.mcp_url,
    credentialJson: JSON.stringify(credentials, null, 2),
    snippet: payload.snippet,
  };
}

type Blocked = {
  kind: 'blocked';
  tone: 'danger' | 'warning';
  text: string;
  reissue: boolean;
};

type View =
  | { kind: 'loading' }
  | { kind: 'ready'; paste: McpPaste }
  | Blocked;

function viewFor(body: MyMcpConfig): View {
  const paste = mcpPaste(body);
  if (!paste) {
    return { kind: 'blocked', tone: 'warning', text: EMPTY.credentials_unavailable, reissue: true };
  }
  return { kind: 'ready', paste };
}

function blockedFor(e: unknown, keepReissue: boolean): Blocked {
  const code = e instanceof ApiError ? e.body.error : null;
  if (code === 'no_private_space') {
    return { kind: 'blocked', tone: 'danger', text: EMPTY.no_private_space, reissue: false };
  }
  if (code === 'no_private_connection') {
    return { kind: 'blocked', tone: 'danger', text: EMPTY.no_private_connection, reissue: false };
  }
  if (code === 'connection_pending') {
    return { kind: 'blocked', tone: 'warning', text: EMPTY.connection_pending, reissue: false };
  }
  if (code === 'credentials_unavailable') {
    return { kind: 'blocked', tone: 'warning', text: EMPTY.credentials_unavailable, reissue: true };
  }
  return {
    kind: 'blocked',
    tone: 'danger',
    text: e instanceof Error ? e.message : 'Could not load',
    reissue: keepReissue,
  };
}

/**
 * Settings → MCP. The caller's own connection, as three paste strings.
 * Mounting the page only reads. Reissue is the button.
 */
export function Mcp() {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    myMcpApi.get().then(
      (body) => { if (!cancelled) setView(viewFor(body)); },
      (e: unknown) => { if (!cancelled) setView(blockedFor(e, false)); },
    );
    return () => { cancelled = true; };
  }, []);

  const reissue = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setView(viewFor(await myMcpApi.reissue()));
    } catch (e) {
      setView(blockedFor(e, true));
    } finally {
      setBusy(false);
    }
  };

  if (view.kind === 'loading') return <p className="text-sm text-muted">Loading…</p>;

  const offerReissue = view.kind === 'ready' || view.reissue;

  return (
    <div className="max-w-2xl space-y-6">
      {view.kind === 'blocked' && <Notice tone={view.tone}>{view.text}</Notice>}
      {view.kind === 'ready' && !busy && (
        <Card
          title="Connect your agent"
          subtitle="Paste these into the agent that should use your private Space."
        >
          <div className="space-y-4">
            <PasteBlock label="Endpoint" text={view.paste.endpoint} />
            <PasteBlock label="Credentials" text={view.paste.credentialJson} />
            <PasteBlock label="Harness snippet" text={view.paste.snippet} />
          </div>
        </Card>
      )}
      {offerReissue && (
        <Card title="Issue a new connection">
          <div className="space-y-3">
            <Notice tone="warning">{REISSUE_COPY}</Notice>
            <Button variant="primary" disabled={busy} onClick={() => void reissue()}>
              {busy ? 'Issuing…' : 'Issue a new connection'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function PasteBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-medium">{label}</h3>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <pre className={BLOCK}>{text}</pre>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <Button aria-live="polite" aria-label={copied ? 'Copied' : label} onClick={() => void copy()}>
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}
