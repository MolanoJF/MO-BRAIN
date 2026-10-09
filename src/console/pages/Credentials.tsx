import { useEffect, useState } from 'react';
import {
  ApiError, credentialsApi,
  type CredentialStatus, type CredentialsStatus, type GithubSaveResult, type GithubScope,
} from '../api.ts';
import { Button, Card, ConfirmButton, Input, Notice } from '../ui/index.tsx';

/** "Configured · updated 2026-10-09 · v2" or "Not set". Status only, never a value. */
export function credentialStatusText(s: CredentialStatus): string {
  if (!s.configured) return 'Not set';
  const parts = ['Configured'];
  if (s.updatedAt) {
    const d = new Date(s.updatedAt);
    if (!Number.isNaN(d.getTime())) parts.push(`updated ${d.toISOString().slice(0, 10)}`);
  }
  if (s.version !== null) parts.push(`v${s.version}`);
  return parts.join(' · ');
}

const NO_SPACE = /\s/;

/** Mirrors the server's printable, no-whitespace rule; the server still decides. */
export function githubTokenError(token: string): string | null {
  const t = token.trim();
  if (t === '') return 'Paste a GitHub token.';
  if (NO_SPACE.test(t)) return 'A token has no spaces.';
  return null;
}

export function anthropicKeyError(key: string): string | null {
  const t = key.trim();
  if (t === '') return 'Paste an Anthropic API key.';
  if (NO_SPACE.test(t)) return 'A key has no spaces.';
  if (!t.startsWith('sk-ant-')) return 'An Anthropic key starts with sk-ant-.';
  return null;
}

export function openaiKeyError(key: string): string | null {
  const t = key.trim();
  if (t === '') return 'Paste an OpenAI API key.';
  if (NO_SPACE.test(t)) return 'A key has no spaces.';
  return null;
}

/** What a GitHub token save did to existing remotes. */
export function githubSaveText(r: Pick<GithubSaveResult, 'refreshed' | 'failed'>): string {
  const base = 'Saved.';
  const ok = r.refreshed.length > 0
    ? ` Updated the remote of ${r.refreshed.length === 1 ? r.refreshed[0] : `${r.refreshed.length} Sources`}.`
    : '';
  const bad = r.failed.length > 0
    ? ` Could not update: ${r.failed.map((f) => `${f.sourceId} (${f.error})`).join('; ')}. Try saving again.`
    : '';
  return `${base}${ok}${bad}`;
}

function reason(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message !== '') return e.message;
  return 'Request failed';
}

/**
 * One credential: its status, a write-only field and Save, and optionally Remove.
 * The field is cleared after a save and the value is never read back from the server.
 */
function SecretCard({
  title, subtitle, status, label, placeholder, validate, onSave, onRemove, removeLabel = 'Remove',
}: {
  title: string;
  subtitle: string;
  status: CredentialStatus;
  label: string;
  placeholder: string;
  validate: (v: string) => string | null;
  onSave: (v: string) => Promise<string>;
  onRemove?: () => Promise<void>;
  removeLabel?: string;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    const invalid = validate(value);
    if (invalid !== null) { setMsg({ ok: false, text: invalid }); return; }
    setSaving(true); setMsg(null);
    try {
      const text = await onSave(value.trim());
      setValue('');
      setMsg({ ok: true, text });
    } catch (e) { setMsg({ ok: false, text: reason(e) }); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!onRemove) return;
    setSaving(true); setMsg(null);
    try { await onRemove(); setMsg({ ok: true, text: 'Removed.' }); }
    catch (e) { setMsg({ ok: false, text: reason(e) }); }
    finally { setSaving(false); }
  };

  return (
    <Card title={title} subtitle={subtitle}>
      <div className="space-y-3">
        <p className="text-[length:var(--control-font)]">{credentialStatusText(status)}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="password" autoComplete="off" aria-label={label} className="max-w-sm font-mono"
                 placeholder={placeholder} value={value} disabled={saving}
                 onChange={(e) => setValue(e.target.value)} />
          <Button variant="primary" disabled={saving || value.trim() === ''} onClick={() => void save()}>
            {saving ? 'Saving…' : status.configured ? 'Replace' : 'Save'}
          </Button>
          {onRemove && status.configured && (
            <ConfirmButton label={removeLabel} confirmLabel="Confirm remove" disabled={saving}
                           onConfirm={() => void remove()} />
          )}
        </div>
        {saving && <p className="text-xs text-muted">Working. Updating remotes can take a moment.</p>}
        {msg && <Notice tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</Notice>}
      </div>
    </Card>
  );
}

export const CREDENTIALS_FOOTNOTE =
  'Credentials are stored encrypted, are never shown again after you save them, and are never given to the agent runner.';

export function Credentials() {
  const [data, setData] = useState<CredentialsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try { setData(await credentialsApi.status()); }
    catch (e) { setError(reason(e)); }
  };
  useEffect(() => { void load(); }, []);

  if (!data) return error ? <Notice tone="danger">{error}</Notice> : <p className="text-sm text-muted">Loading…</p>;

  const github = (scope: GithubScope) => ({
    onSave: async (token: string) => {
      const r = await credentialsApi.setGithub(scope, token);
      await load();
      return githubSaveText(r);
    },
    onRemove: async () => { await credentialsApi.clearGithub(scope); await load(); },
  });

  return (
    <div className="space-y-6 max-w-xl">
      <SecretCard
        title="Your GitHub token"
        subtitle="Used for your private Space's git remote. Needs the repo scope."
        status={data.github.member} label="GitHub token" placeholder="GitHub token (repo scope)"
        validate={githubTokenError} {...github('member')}
      />
      {data.github.org && (
        <SecretCard
          title="Company GitHub token"
          subtitle="Used for the git remotes of company Sources."
          status={data.github.org} label="Company GitHub token" placeholder="GitHub token (repo scope)"
          validate={githubTokenError} {...github('org')}
        />
      )}
      {data.anthropic && (
        <SecretCard
          title="Anthropic API key"
          subtitle="Used by the agent model gateway. Takes effect on the next model call."
          status={data.anthropic} label="Anthropic API key" placeholder="sk-ant-…"
          validate={anthropicKeyError}
          onSave={async (key) => { await credentialsApi.setAnthropic(key); await load(); return 'Saved.'; }}
        />
      )}
      {data.openai && (
        <SecretCard
          title="OpenAI API key"
          subtitle="Used for embeddings."
          status={data.openai} label="OpenAI API key" placeholder="sk-…"
          validate={openaiKeyError}
          onSave={async (key) => { await credentialsApi.setOpenai(key); await load(); return 'Saved.'; }}
        />
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <p className="text-xs text-muted">{CREDENTIALS_FOOTNOTE}</p>
    </div>
  );
}
