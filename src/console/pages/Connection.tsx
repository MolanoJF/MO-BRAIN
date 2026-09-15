import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { autoInstall, connectionClass, wiringSnippet } from '../../control/harness.ts';

type Role = 'owner' | 'admin' | 'member' | 'viewer';
type Member = { id: string; email: string; role: Role };
type Space = { id: string; sourceId: string; name: string };
type Adapter = { id: string; connectionClass?: string; autoInstall?: boolean };
type ConnectionRow = {
  id: string;
  membershipId: string;
  writeSpaceId: string;
  readSpaceIds: unknown;
  harness: string;
  state: string;
  clientName: string;
  profile: string;
  boundSlugPrefixes: unknown;
};
type Warning = { id: string; severity: string; affects: string[] };
type Compiled = {
  profile: string;
  sourceId: string;
  federatedRead: string[];
  boundSlugPrefixes: string[] | null;
  warnings: Warning[];
};
type Diff = { removals: string[]; additions: string[]; requiresNewToken: boolean };
type Preview = {
  compiled: Compiled;
  serverPreview: unknown | null;
  diff: Diff;
  previewSource: 'server' | 'computed';
};

const ISOLATION_NOTICE =
  'A Space is a whole gbrain source. Folders inside it are NOT access boundaries — ' +
  'every member with read on that Space can retrieve everything in it via semantic search. ' +
  'If something needs isolation, it needs its own Space.';

const WARNING_COPY: Record<string, string> = {
  'read-isolation-per-space':
    'Read is isolated per Space. Folders inside a Space are not access boundaries.',
  'write-fence-disables-extraction':
    'A write fence also disables fact extraction and ingestion.',
  'additions-need-new-token':
    'Additions require a new token. Removals apply to the live token immediately.',
  'rotation-is-not-revocation':
    'Rotating a token is not revocation — the old token still works until it expires or is revoked.',
  'verify-partial-is-not-green': 'server checks passed, harness evidence missing.',
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

function spaceLabel(spaces: Space[], id: string): string {
  const s = spaces.find((x) => x.id === id);
  return s ? (s.name || s.sourceId) : id;
}

function previewExitCode(serverPreview: unknown): number | null {
  if (!serverPreview || typeof serverPreview !== 'object') return null;
  const rec = serverPreview as Record<string, unknown>;
  return typeof rec.exitCode === 'number' ? rec.exitCode : null;
}

export function Connection() {
  const [members, setMembers] = useState<Member[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [adapters, setAdapters] = useState<Adapter[]>([]);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [notice, setNotice] = useState(ISOLATION_NOTICE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [membershipId, setMembershipId] = useState('');
  const [writeSpaceIds, setWriteSpaceIds] = useState<string[]>([]);
  const [readSpaceIds, setReadSpaceIds] = useState<string[]>([]);
  const [harness, setHarness] = useState('');
  const [fence, setFence] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [previews, setPreviews] = useState<Preview[] | null>(null);

  const load = async () => {
    const [roster, overview, harnesses, conns, wizard] = await Promise.all([
      api.get<{ members: Member[] }>('/members'),
      api.get<{ spaces: Space[] }>('/access-overview'),
      api.get<{ adapters: Adapter[] }>('/harnesses'),
      api.get<{ connections: ConnectionRow[] }>('/connections'),
      api.get<{ isolationNotice?: string }>('/wizard/state').catch(() => ({ isolationNotice: ISOLATION_NOTICE })),
    ]);
    setMembers(roster.members);
    setSpaces(overview.spaces);
    setAdapters(harnesses.adapters);
    setConnections(conns.connections);
    if (wizard.isolationNotice) setNotice(wizard.isolationNotice);
    if (!harness && harnesses.adapters[0]) setHarness(harnesses.adapters[0].id);
  };

  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : 'Load failed')); }, []);

  const prefixes = useMemo(
    () => fence.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
    [fence],
  );

  const bodyFor = (writeSpaceId: string) => {
    const body: Record<string, unknown> = {
      membershipId,
      writeSpaceId,
      readSpaceIds,
      harness,
    };
    if (prefixes.length > 0) body.boundSlugPrefixes = prefixes;
    return body;
  };

  const member = members.find((m) => m.id === membershipId);
  const canGo = Boolean(membershipId && writeSpaceIds.length > 0 && harness && acknowledged);

  const step = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Step failed'); }
    finally { setBusy(false); }
  };

  const preview = () => step(async () => {
    const next: Preview[] = [];
    for (const writeSpaceId of writeSpaceIds) {
      next.push(await api.post<Preview>('/connections/preview', bodyFor(writeSpaceId)));
    }
    setPreviews(next);
  });

  const submit = () => step(async () => {
    for (const writeSpaceId of writeSpaceIds) {
      await api.post('/connections', bodyFor(writeSpaceId));
    }
    setPreviews(null);
    setWriteSpaceIds([]);
    setAcknowledged(false);
    await load();
  });

  const grouped = useMemo(() => {
    const map = new Map<string, ConnectionRow[]>();
    for (const c of connections) {
      const list = map.get(c.membershipId) ?? [];
      list.push(c);
      map.set(c.membershipId, list);
    }
    return map;
  }, [connections]);

  let snippet = '';
  try {
    if (harness) snippet = wiringSnippet(harness, { client_id: '<client_id>', mcp_url: '<mcp_url>' });
  } catch { /* unknown adapter until picker loads */ }

  return (
    <div className="max-w-2xl space-y-8">
      <header>
        <h1 className="text-xl font-semibold">Connection</h1>
        <p className="text-sm text-muted">
          A Connection is one write Space. Two write Spaces are two Connections — never one row with two writes.
        </p>
      </header>

      {error && <div className="text-danger text-sm">{error}</div>}

      <section className="space-y-3">
        <h2 className="font-medium">Existing</h2>
        {connections.length === 0 && <p className="text-sm text-muted">No connections yet.</p>}
        {[...grouped.entries()].map(([mid, rows]) => {
          const m = members.find((x) => x.id === mid);
          return (
            <div key={mid} className="space-y-2">
              <h3 className="text-sm font-medium">{m?.email ?? mid}</h3>
              {rows.map((row) => (
                <div key={row.id} className="card space-y-1">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">Write: {spaceLabel(spaces, row.writeSpaceId)}</span>
                    <span className="font-mono text-sm text-muted">{row.state}</span>
                  </div>
                  <div className="text-sm text-muted">
                    Read: {asStringArray(row.readSpaceIds).map((id) => spaceLabel(spaces, id)).join(', ') || 'none'}
                  </div>
                  <div className="text-sm font-mono text-muted">{row.harness} · {row.clientName}</div>
                </div>
              ))}
            </div>
          );
        })}
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">New connections</h2>
        <label className="text-sm">Member
          <select className="field mt-1" value={membershipId}
                  onChange={(e) => { setMembershipId(e.target.value); setPreviews(null); }}>
            <option value="">Select member…</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.email} ({m.role})</option>
            ))}
          </select>
        </label>

        {/* S4b: a blocking choice, not a tooltip. */}
        <div className="card border-warning">
          <p className="text-sm">{notice}</p>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={acknowledged}
                   onChange={(e) => setAcknowledged(e.target.checked)} />
            I understand folders inside a Space are not access boundaries.
          </label>
        </div>

        <div>
          <div className="text-sm font-medium mb-2">Write Spaces</div>
          {spaces.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm py-1">
              <input type="checkbox" checked={writeSpaceIds.includes(s.id)}
                     onChange={() => { setWriteSpaceIds(toggle(writeSpaceIds, s.id)); setPreviews(null); }} />
              {s.name || s.sourceId}
            </label>
          ))}
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">Connections this will create</div>
          {writeSpaceIds.length === 0 && (
            <p className="text-sm text-muted">Pick write Spaces. Each write Space is its own Connection row.</p>
          )}
          {writeSpaceIds.map((id) => (
            <div key={id} className="card space-y-1">
              <div className="font-medium">Write: {spaceLabel(spaces, id)}</div>
              <div className="text-sm text-muted">
                Read: {readSpaceIds.map((rid) => spaceLabel(spaces, rid)).join(', ') || 'none'}
              </div>
              <div className="text-sm font-mono text-muted">{harness || 'no harness'}</div>
            </div>
          ))}
        </div>

        <div>
          <div className="text-sm font-medium mb-2">Read Spaces</div>
          {spaces.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm py-1">
              <input type="checkbox" checked={readSpaceIds.includes(s.id)}
                     onChange={() => { setReadSpaceIds(toggle(readSpaceIds, s.id)); setPreviews(null); }} />
              {s.name || s.sourceId}
            </label>
          ))}
        </div>

        <label className="text-sm">Harness
          <select className="field mt-1" value={harness}
                  onChange={(e) => { setHarness(e.target.value); setPreviews(null); }}>
            {adapters.map((a) => {
              let klass = a.connectionClass;
              let auto = a.autoInstall;
              try { klass = connectionClass(a.id); auto = autoInstall(a.id); } catch { /* keep API annotation */ }
              return (
                <option key={a.id} value={a.id}>
                  {a.id} ({klass ?? 'unknown'}{auto ? '' : ', copy/paste'})
                </option>
              );
            })}
          </select>
        </label>
        {snippet && <pre className="field font-mono text-xs whitespace-pre-wrap">{snippet}</pre>}

        <label className="text-sm">Write fence prefixes (optional)
          <input className="field mt-1 font-mono" placeholder="agents/alice/, drafts/"
                 value={fence} onChange={(e) => { setFence(e.target.value); setPreviews(null); }} />
        </label>
        {prefixes.length > 0 && (
          <div className="card border-warning text-sm">
            A write fence also kills fact extraction and ingestion. Preview to see the full affects list inline.
          </div>
        )}

        <button className="btn-primary" disabled={busy || !canGo} onClick={() => void preview()}>
          {busy ? 'Working…' : 'Preview'}
        </button>
      </section>

      {previews && (
        <ConfirmScreen
          previews={previews}
          memberEmail={member?.email ?? 'member'}
          spaces={spaces}
          writeSpaceIds={writeSpaceIds}
          busy={busy}
          acknowledged={acknowledged}
          onSubmit={() => void submit()}
        />
      )}
    </div>
  );
}

function ConfirmScreen({
  previews, memberEmail, spaces, writeSpaceIds, busy, acknowledged, onSubmit,
}: {
  previews: Preview[];
  memberEmail: string;
  spaces: Space[];
  writeSpaceIds: string[];
  busy: boolean;
  acknowledged: boolean;
  onSubmit: () => void;
}) {
  return (
    <section className="space-y-4">
      <h2 className="font-medium">Confirm</h2>
      {previews.map((preview, i) => (
        <PreviewCard
          key={writeSpaceIds[i] ?? i}
          preview={preview}
          memberEmail={memberEmail}
          writeLabel={spaceLabel(spaces, writeSpaceIds[i] ?? '')}
        />
      ))}
      <button className="btn-primary" disabled={busy || !acknowledged} onClick={onSubmit}>
        {busy ? 'Creating…' : `Create ${previews.length} Connection${previews.length === 1 ? '' : 's'}`}
      </button>
    </section>
  );
}

function PreviewCard({
  preview, memberEmail, writeLabel,
}: {
  preview: Preview;
  memberEmail: string;
  writeLabel: string;
}) {
  const fenceWarning = preview.compiled.warnings.find((w) => w.id === 'write-fence-disables-extraction');
  const exitCode = previewExitCode(preview.serverPreview);
  const verifyAmber = exitCode === 2
    || preview.compiled.warnings.some((w) => w.id === 'verify-partial-is-not-green');

  return (
    <div className="card space-y-3">
      <div className="font-medium">Write: {writeLabel}</div>
      <div className="text-sm text-muted font-mono">
        profile {preview.compiled.profile} · source {preview.compiled.sourceId}
      </div>

      {preview.previewSource === 'computed' && (
        <p className="text-sm text-warning">
          This is our computed diff, not a server preview.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-muted mb-1">Before (removals)</div>
          {preview.diff.removals.length === 0
            ? <span className="text-muted">—</span>
            : preview.diff.removals.map((r) => <div key={r} className="font-mono">{r}</div>)}
        </div>
        <div>
          <div className="text-muted mb-1">After (additions)</div>
          {preview.diff.additions.length === 0
            ? <span className="text-muted">—</span>
            : preview.diff.additions.map((a) => <div key={a} className="font-mono">{a}</div>)}
          {preview.diff.requiresNewToken && (
            <div className="border-warning text-warning text-xs mt-2 p-2">
              requires a new token — {memberEmail} must re-run the wiring on their laptop
            </div>
          )}
          {preview.compiled.boundSlugPrefixes !== null && (
            <div className="mt-2">
              <div className="font-mono">
                fence: {preview.compiled.boundSlugPrefixes.join(', ') || '(empty)'}
              </div>
              {fenceWarning && fenceWarning.affects.length > 0 && (
                <div className="mt-1">
                  <div className="text-warning">Write fence also kills:</div>
                  <ul className="list-disc pl-4">
                    {fenceWarning.affects.map((a) => <li key={a} className="font-mono text-xs">{a}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="text-sm space-y-1">
        <div className="text-muted">Read: {preview.compiled.federatedRead.join(', ') || 'none'}</div>
      </div>

      <div className="space-y-2">
        {preview.compiled.warnings.map((w) => {
          const verify = w.id === 'verify-partial-is-not-green';
          const copy = WARNING_COPY[w.id] ?? w.id;
          return (
            <div key={w.id} className={verify ? 'card border-warning' : 'text-sm'}>
              <span className={verify ? 'text-warning' : w.severity === 'info' ? 'text-muted' : 'text-warning'}>
                {w.id}
              </span>
              <p className={`text-sm ${verify ? 'text-warning' : 'text-muted'}`}>{copy}</p>
              {w.id === 'write-fence-disables-extraction' && w.affects.length > 0 && (
                <p className="text-xs font-mono text-muted">{w.affects.join(', ')}</p>
              )}
            </div>
          );
        })}
      </div>

      {verifyAmber && (
        <div className="card border-warning">
          <div className="text-warning font-medium">
            mcp verify{exitCode === 2 ? ' exit 2' : ''}
          </div>
          <p className="text-sm text-warning">server checks passed, harness evidence missing.</p>
        </div>
      )}
    </div>
  );
}
