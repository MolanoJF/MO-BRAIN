import { useEffect, useState } from 'react';
import { grantsApi, type GrantRow } from '../api.ts';
import { Button, Card, Notice } from '../ui/index.tsx';

type Access = 'none' | 'read' | 'write';
type Member = { id: string; email: string; role: string };
type Space = { id: string; name: string };

/** One click moves a cell one step; removing a grant is the step after write. */
export function nextAccess(current: Access): Access {
  return current === 'none' ? 'read' : current === 'read' ? 'write' : 'none';
}

/**
 * Who may read or write each COMPANY Space. Admins and owners are not listed:
 * they reach every company Space without a grant. Personal Spaces never
 * appear — nobody but their owner can be given them.
 */
export function GrantsCard({ members, spaces }: { members: Member[]; spaces: Space[] }) {
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => setGrants((await grantsApi.list()).grants);
  useEffect(() => { void load().catch((e) => setError(String(e?.message ?? e))); }, []);

  const grantees = members.filter((m) => m.role === 'member' || m.role === 'viewer');
  const accessOf = (membershipId: string, spaceId: string): Access =>
    grants.find((g) => g.membershipId === membershipId && g.spaceId === spaceId)?.access ?? 'none';

  const cycle = async (membershipId: string, spaceId: string) => {
    setBusy(true); setError(null);
    try {
      const next = nextAccess(accessOf(membershipId, spaceId));
      if (next === 'none') await grantsApi.remove(membershipId, spaceId);
      else await grantsApi.put({ membershipId, spaceId, access: next });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Grant change failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="font-medium">Company access</h2>
      <p className="text-sm text-muted">
        Click a cell to cycle none → read → write. Removing access also revokes the
        member's connections that used it.
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      {grantees.length === 0 || spaces.length === 0 ? (
        <p className="text-sm text-muted">No members or company Sources yet.</p>
      ) : (
        <table className="text-sm">
          <thead>
            <tr><th className="text-left pr-4">Member</th>{spaces.map((s) => <th key={s.id} className="pr-4">{s.name}</th>)}</tr>
          </thead>
          <tbody>
            {grantees.map((m) => (
              <tr key={m.id}>
                <td className="pr-4">{m.email}</td>
                {spaces.map((s) => (
                  <td key={s.id} className="pr-4">
                    <Button disabled={busy} onClick={() => cycle(m.id, s.id)}>{accessOf(m.id, s.id)}</Button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
