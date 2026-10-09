import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { ApiError, type SetRemoteBody, type SpacePush } from './api.ts';
import { Button, Icon, Input } from './ui/index.tsx';
import { SettingsLink } from './ui/SettingsLink.tsx';

/**
 * Git remote controls for ONE Space. The same panel serves an admin on the
 * Sources page, a member on My brain (their own private Space) and the first-run
 * wizard; each hands in the routes it is allowed to call as `api`.
 */
export type RemoteApi = {
  set: (body: SetRemoteBody) => Promise<{ remote: string; created: string | null; push: SpacePush | null }>;
  push: () => Promise<{ push: SpacePush }>;
  clear: () => Promise<unknown>;
};

export const TOKEN_MISSING_TEXT = 'Add a GitHub token in Settings → Credentials first.';

function reason(e: unknown): string {
  if (e instanceof ApiError) return e.message === 'github_token_missing' ? TOKEN_MISSING_TEXT : e.message;
  if (e instanceof Error && e.message !== '') return e.message;
  return 'Request failed';
}

/**
 * Git remote. The two ways to give a Space a home off the box: connect a repo
 * that already exists, or have Mo-brain create a private GitHub repo. Validators
 * are pure so the copy and the gating are testable without a DOM; the server
 * re-checks everything (`src/ops/git.ts` `validateRemoteUrl`).
 */
export type RemoteMode = 'url' | 'github';

export const REMOTE_NOTICE =
  'The GitHub token is stored encrypted and used only to push this Source. Mo-brain refuses to push ' +
  'to a remote it cannot verify is private, and blocks a push when a secret scan finds credentials.';

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;

type RemoteFields = { url: string; name: string; token: string; tokenStored?: boolean };

/** A token is only needed here when none is stored for the scope. */
export function remoteError(mode: RemoteMode, f: RemoteFields): string | null {
  if (!f.tokenStored && f.token.trim() === '') return TOKEN_MISSING_TEXT;
  if (mode === 'url') {
    let u: URL;
    try { u = new URL(f.url.trim()); } catch { return 'Enter the repository URL, e.g. https://github.com/you/brain.git.'; }
    if (u.protocol !== 'https:') return 'The repository URL must start with https://.';
    if (u.username !== '' || u.password !== '') return 'Leave credentials out of the URL; paste the token in its own field.';
    if (u.pathname.replace(/\//g, '') === '') return 'The URL must name a repository.';
    return null;
  }
  if (!GITHUB_NAME.test(f.name.trim())) {
    return 'Repository name may only use letters, digits, ".", "_" and "-" (at most 100 characters).';
  }
  return null;
}

export function canSetRemote(mode: RemoteMode, f: RemoteFields): boolean {
  return remoteError(mode, f) === null;
}

/**
 * Which stored token covers this panel, and whether the panel may take one
 * inline. `stored: null` means the status is still loading. `save` exists only
 * where Settings is unreachable (the first-run wizard).
 */
export type RemoteToken = {
  stored: boolean | null;
  scope: 'member' | 'org';
  save?: (token: string) => Promise<unknown>;
};

/** The line shown in place of a token field. */
export function tokenSourceText(scope: 'member' | 'org'): string {
  return scope === 'org'
    ? 'Uses the company GitHub token from Settings → Credentials.'
    : 'Uses your GitHub token from Settings → Credentials.';
}

/** One sentence for what a push did — the refusal text is gbrain's own. */
export function pushText(push: SpacePush | null): string {
  if (push === null) return 'Connected. Not pushed yet.';
  if (push.pushed) return 'Pushed.';
  return `Connected, but the push did not go through (exit ${push.exitCode}).${push.detail ? ` ${push.detail}` : ''}`;
}

export function RemotePanel({ sourceId, gitRemote, status, busy, api, onChanged, token: tokenInfo, pushOnConnect = true }: {
  sourceId: string;
  gitRemote: string | null;
  /** One line of git state, shown under the remote once connected. */
  status?: string | null;
  busy: boolean;
  api: RemoteApi;
  onChanged: () => Promise<void> | void;
  token: RemoteToken;
  /** The wizard connects before the brain exists, so there is nothing to push yet. */
  pushOnConnect?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RemoteMode>('github');
  const [url, setUrl] = useState('');
  const [name, setName] = useState(sourceId);
  const [token, setToken] = useState('');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (fn: () => Promise<string | null>) => {
    setWorking(true); setProblem(null); setMessage(null);
    try { setMessage(await fn()); await onChanged(); }
    catch (e) { setProblem(reason(e)); }
    finally { setWorking(false); }
  };

  const connect = () => run(async () => {
    const stored = tokenInfo.stored === true;
    const invalid = remoteError(mode, { url, name, token, tokenStored: stored });
    if (invalid !== null) throw new Error(invalid);
    // Inline entry (wizard only): store it once, then connect with the stored one.
    if (!stored) { await tokenInfo.save!(token.trim()); setToken(''); }
    const push = pushOnConnect ? {} : { push: false };
    const r = await api.set(mode === 'url'
      ? { mode, url: url.trim(), ...push }
      : { mode, name: name.trim(), ...push });
    return `${r.created ? `Created ${r.created}. ` : ''}${pushText(r.push)}`;
  });

  const pushNow = () => run(async () => pushText((await api.push()).push));
  const disconnect = () => run(async () => {
    await api.clear();
    return 'Disconnected. The remote repository itself is untouched.';
  });

  const off = busy || working;
  const stored = tokenInfo.stored === true;
  const missing = tokenInfo.stored === false;
  const inline = missing && tokenInfo.save !== undefined;
  const blocked = tokenInfo.stored === null || (missing && !inline);
  return (
    <div className="space-y-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
              className="flex w-full items-center gap-2 text-left text-[length:var(--control-font)]">
        <Icon glyph={ChevronRight} size={14} className={open ? 'rotate-90 text-muted' : 'text-muted'} />
        <span className="font-medium">Git remote</span>
        <span className="truncate text-muted">{gitRemote ? (status ?? 'Connected') : 'Not connected'}</span>
      </button>
      {open && (gitRemote ? (
        <>
          <div className="text-[length:var(--control-font)] font-mono break-all">{gitRemote}</div>
          <div className="flex flex-wrap gap-2">
            {pushOnConnect && (
              <Button disabled={off} onClick={() => void pushNow()}>{working ? 'Working…' : 'Push now'}</Button>
            )}
            <Button disabled={off} onClick={() => void disconnect()}>Disconnect</Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-muted">
            This Source's history lives only on this server. Give it a git remote to keep a copy elsewhere.
          </p>
          <div className="flex gap-2">
            <Button variant={mode === 'github' ? 'primary' : undefined} disabled={off}
                    onClick={() => setMode('github')}>Create on GitHub</Button>
            <Button variant={mode === 'url' ? 'primary' : undefined} disabled={off}
                    onClick={() => setMode('url')}>Add existing repo</Button>
          </div>
          {stored && <p className="text-xs text-muted">{tokenSourceText(tokenInfo.scope)}</p>}
          {missing && !inline && (
            <p className="text-xs text-muted">
              Add a GitHub token in <SettingsLink tab="credentials">Settings → Credentials</SettingsLink> first.
            </p>
          )}
          {inline && (
            <Input type="password" autoComplete="off" value={token}
                   placeholder="GitHub token (repo scope)"
                   onChange={(e) => setToken(e.target.value)} />
          )}
          <div className="flex gap-2">
            {mode === 'url' ? (
              <Input className="min-w-0 flex-1" placeholder="https://github.com/you/brain.git" value={url}
                     onChange={(e) => setUrl(e.target.value)} />
            ) : (
              <Input className="min-w-0 flex-1" placeholder="Repository name" value={name}
                     onChange={(e) => setName(e.target.value)} />
            )}
            <Button variant="primary" className="shrink-0"
                    disabled={off || blocked || !canSetRemote(mode, { url, name, token, tokenStored: stored })}
                    onClick={() => void connect()}>
              {working ? 'Connecting…' : mode === 'github' ? 'Create private repo and push' : 'Connect and push'}
            </Button>
          </div>
          <p className="text-xs text-muted">{REMOTE_NOTICE}</p>
        </>
      ))}
      {open && message && <div className="text-[length:var(--control-font)]">{message}</div>}
      {open && problem && <div className="text-[length:var(--control-font)] text-danger">{problem}</div>}
    </div>
  );
}
