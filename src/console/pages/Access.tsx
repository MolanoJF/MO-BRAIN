import { useEffect, useState } from 'react';
import { api } from '../api.ts';

type Member = { membershipId: string; email: string; role: string };
type Space = { id: string; sourceId: string; name: string };
type Cell = { membershipId: string; spaceId: string; access: 'write' | 'read' };

export function Access() {
  const [members, setMembers] = useState<Member[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [cells, setCells] = useState<Cell[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.get<{ members: Member[]; spaces: Space[]; cells: Cell[] }>('/access-overview')
      .then((r) => {
        setMembers(r.members);
        setSpaces(r.spaces);
        setCells(r.cells);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Load failed'));
  }, []);

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
    </div>
  );
}
