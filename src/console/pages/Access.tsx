import { useEffect, useState } from 'react';
import { api } from '../api.ts';

type Member = { membershipId: string; email: string; role: string };
type Space = { id: string; sourceId: string; name: string };
type Cell = { membershipId: string; spaceId: string; access: 'write' | 'read' };

/**
 * D12, in plain words, on the page where access is granted. It is the sentence
 * `scripts/install.sh` asks, minus the question mark: the console cannot enable
 * the runner — it is a compose profile, chosen on the host — so asking "Enable
 * it?" here would be a button that does not exist. What the sentence is doing is
 * telling an operator who is about to widen someone's access what the deployment
 * may already be running with the organization's key.
 */
export const AGENT_RUNNER_WARNING =
  'This container runs model-written code against your brain, using your organization\'s API key, on a schedule, '
  + 'with nobody watching. It is off unless the deployment was installed with the runner profile '
  + '(COMPOSE_PROFILES=runner in .env, alongside RUNNER_TOKEN). A deployment that only connects members\' own '
  + 'agents loses nothing by leaving it off, and nothing on this page can switch it on.';

const privateSpaceError = (error: string): string =>
  error === 'already_provisioned' ? 'You already have a private space.'
    : error === 'private_spaces_disabled' ? 'Private spaces are turned off for this organization.'
      : error;

export function Access() {
  const [members, setMembers] = useState<Member[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [cells, setCells] = useState<Cell[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [privateSpacesEnabled, setPrivateSpacesEnabled] = useState<boolean | null>(null);
  const [spaceMsg, setSpaceMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [spaceBusy, setSpaceBusy] = useState(false);

  useEffect(() => {
    void api.get<{ members: Member[]; spaces: Space[]; cells: Cell[] }>('/access-overview')
      .then((r) => {
        setMembers(r.members);
        setSpaces(r.spaces);
        setCells(r.cells);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Load failed'));
    void api.get<{ enabled: boolean }>('/org/private-spaces')
      .then((r) => setPrivateSpacesEnabled(r.enabled))
      .catch(() => setPrivateSpacesEnabled(false));
  }, []);

  const createMySpace = async () => {
    setSpaceBusy(true); setSpaceMsg(null);
    try {
      const r = await api.post<{ ok: true; spaceId: string; sourceId: string; connectionId: string }>('/private-space');
      setSpaceMsg({ ok: true, text: `Private space ready (${r.sourceId}).` });
    } catch (e) {
      setSpaceMsg({ ok: false, text: privateSpaceError(e instanceof Error ? e.message : 'Request failed') });
    } finally { setSpaceBusy(false); }
  };

  const access = (membershipId: string, spaceId: string) =>
    cells.find((c) => c.membershipId === membershipId && c.spaceId === spaceId)?.access;

  return (
    <div className="max-w-4xl space-y-4">
      <header>
        <h1 className="text-xl font-semibold">Access</h1>
        <p className="text-sm text-muted">
          Who can read or write which Space. W = write (one Connection per write Space). R = read.
        </p>
      </header>

      {error && <div className="text-danger text-sm">{error}</div>}

      {/* D12: what enabling the runner means, before anyone reads the matrix. */}
      <section className="card border-warning">
        <h2 className="text-sm font-semibold text-warning">The agent runner</h2>
        <p className="text-sm">{AGENT_RUNNER_WARNING}</p>
      </section>

      {spaces.length === 0 ? (
        <p className="text-sm text-muted">No Spaces yet.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-subtle text-left">
                <th className="py-2 pr-3">Member</th>
                {spaces.map((s) => (
                  <th key={s.id} className="py-2 px-2 font-mono">{s.name || s.sourceId}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.membershipId} className="border-b border-subtle">
                  <td className="py-2 pr-3">
                    <div>{m.email}</div>
                    <div className="text-xs text-muted font-mono">{m.role}</div>
                  </td>
                  {spaces.map((s) => {
                    const a = access(m.membershipId, s.id);
                    return (
                      <td key={s.id} className="py-2 px-2">
                        {a === 'write' && <span className="font-semibold" title="write">W</span>}
                        {a === 'read' && <span className="text-muted" title="read">R</span>}
                        {!a && <span className="text-muted">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="card space-y-2">
        <h2 className="text-sm font-semibold">My private space</h2>
        {privateSpacesEnabled === false ? (
          <p className="text-sm text-muted">
            Private spaces are turned off for this organization.
          </p>
        ) : (
          <button className="btn-primary"
                  disabled={spaceBusy || privateSpacesEnabled === null}
                  onClick={() => void createMySpace()}>
            {spaceBusy ? 'Creating…' : 'Create my private space'}
          </button>
        )}
        {spaceMsg && (
          <p className={`text-sm ${spaceMsg.ok ? 'text-muted' : 'text-danger'}`}>{spaceMsg.text}</p>
        )}
      </section>
    </div>
  );
}
