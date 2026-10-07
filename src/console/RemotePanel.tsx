import { useState } from 'react';
import { ApiError, type SetRemoteBody, type SpacePush } from './api.ts';
import { Button, Input } from './ui/index.tsx';

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

function reason(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message !== '') return e.message;
  return 'Request failed';
}

/**
 * Git remote. The two ways to give a Space a home off the box: connect a repo
 * that already exists, or have Mobrain create a private GitHub repo. Validators
 * are pure so the copy and the gating are testable without a DOM; the server
 * re-checks everything (`src/ops/git.ts` `validateRemoteUrl`).
 */
export type RemoteMode = 'url' | 'github';

export const REMOTE_NOTICE =
  'The access token is stored encrypted and used only to push this Space. Mobrain refuses to push ' +
  'to a remote it cannot verify is private, and blocks a push when a secret scan finds credentials.';

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function remoteError(
  mode: RemoteMode, f: { url: string; name: string; token: string },
): string | null {
  if (f.token.trim() === '') return 'An access token is required.';
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

export function canSetRemote(
  mode: RemoteMode, f: { url: string; name: string; token: string },
): boolean {
  return remoteError(mode, f) === null;
}

/** One sentence for what a push did — the refusal text is gbrain's own. */
export function pushText(push: SpacePush | null): string {
  if (push === null) return 'Connected. Not pushed yet.';
  if (push.pushed) return 'Pushed.';
  return `Connected, but the push did not go through (exit ${push.exitCode}).${push.detail ? ` ${push.detail}` : ''}`;
}

export function RemotePanel({ sourceId, gitRemote, busy, api, onChanged, pushOnConnect = true }: {
  sourceId: string;
  gitRemote: string | null;
  busy: boolean;
  api: RemoteApi;
  onChanged: () => Promise<void> | void;
  /** The wizard connects before the brain exists, so there is nothing to push yet. */
  pushOnConnect?: boolean;
}) {
  const [mode, setMode] = useState<RemoteMode>('github');
  const [url, setUrl] = useState('');
  const [name, setName] = useState(sourceId);
  const [owner, setOwner] = useState('');
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
    const fields = { url, name, token };
    const invalid = remoteError(mode, fields);
    if (invalid !== null) throw new Error(invalid);
    const push = pushOnConnect ? {} : { push: false };
    const r = await api.set(mode === 'url'
      ? { mode, url: url.trim(), token: token.trim(), ...push }
      : { mode, name: name.trim(), token: token.trim(), ...(owner.trim() ? { owner: owner.trim() } : {}), ...push });
    setToken('');
    return `${r.created ? `Created ${r.created}. ` : ''}${pushText(r.push)}`;
  });

  const pushNow = () => run(async () => pushText((await api.push()).push));
  const disconnect = () => run(async () => {
    await api.clear();
    return 'Disconnected. The remote repository itself is untouched.';
  });

  const off = busy || working;
  return (
    <div className="space-y-2">
      <div className="text-[length:var(--control-font)] font-medium">Git remote</div>
      {gitRemote ? (
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
            This Space's history lives only on this server. Give it a git remote to keep a copy elsewhere.
          </p>
          <div className="flex gap-2">
            <Button variant={mode === 'github' ? 'primary' : undefined} disabled={off}
                    onClick={() => setMode('github')}>Create on GitHub</Button>
            <Button variant={mode === 'url' ? 'primary' : undefined} disabled={off}
                    onClick={() => setMode('url')}>Add existing repo</Button>
          </div>
          {mode === 'url' ? (
            <Input placeholder="https://github.com/you/brain.git" value={url}
                   onChange={(e) => setUrl(e.target.value)} />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Input className="max-w-xs" placeholder="Repository name" value={name}
                     onChange={(e) => setName(e.target.value)} />
              <Input className="max-w-xs" placeholder="Owner (default: the token's account)" value={owner}
                     onChange={(e) => setOwner(e.target.value)} />
            </div>
          )}
          <Input type="password" autoComplete="off" value={token}
                 placeholder={mode === 'github' ? 'GitHub token (repo scope)' : 'Access token for that repository'}
                 onChange={(e) => setToken(e.target.value)} />
          <Button variant="primary" disabled={off || !canSetRemote(mode, { url, name, token })}
                  onClick={() => void connect()}>
            {working ? 'Connecting…' : mode === 'github' ? 'Create private repo and push' : 'Connect and push'}
          </Button>
          <p className="text-xs text-muted">{REMOTE_NOTICE}</p>
        </>
      )}
      {message && <div className="text-[length:var(--control-font)]">{message}</div>}
      {problem && <div className="text-[length:var(--control-font)] text-danger">{problem}</div>}
    </div>
  );
}
