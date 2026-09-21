/**
 * S1 — the ONE derivation of "can this membership touch this Space, and how".
 *
 * The Access matrix (`/access-overview`) and the Files routes both call this,
 * so a cell the page renders as `read` is exactly a read the Files browser
 * will allow. Two callers computing permission independently is the drift this
 * module exists to prevent (plan §1.3).
 *
 * IMPORTANT: the connection state set is the EXISTING `('pending','active')`
 * pair the Access matrix has always counted. The plan's word is "active", but
 * the page this replaces — and therefore the page that must not silently
 * change — treats a pending invitation as access too. Preserve the pair.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Role } from './rbac.ts';
import { getDb, schema } from './db/client.ts';

/**
 * The columns this derivation needs from a `connections` row. A full row
 * satisfies it; a projection may carry only these.
 */
export type ConnRow = { writeSpaceId: string; readSpaceIds: unknown };

/**
 * Pure: a role plus one member's connection rows decides one Space.
 *
 * `admin`/`owner` reach every Space in the org. A connection's write Space
 * beats any read listing of the same Space, and a `readSpaceIds` entry that is
 * not a string (the column is jsonb, so it can hold anything) is skipped
 * rather than guessed at.
 */
export function accessFromConnections(
  role: Role,
  conns: readonly ConnRow[],
  spaceId: string,
): 'write' | 'read' | null {
  if (role === 'admin' || role === 'owner') return 'write';
  let read = false;
  for (const conn of conns) {
    if (conn.writeSpaceId === spaceId) return 'write';
    const listed = Array.isArray(conn.readSpaceIds) ? conn.readSpaceIds : [];
    for (const sid of listed) {
      if (typeof sid === 'string' && sid === spaceId) read = true;
    }
  }
  return read ? 'read' : null;
}

/**
 * DB-backed. Scoped to the ORG as well as the membership: a connection row is
 * trusted only when both match, so a stale membership id from another org can
 * never borrow access.
 */
export async function spaceAccess(
  orgId: string,
  membershipId: string,
  role: Role,
  spaceId: string,
): Promise<'write' | 'read' | null> {
  const conns = await getDb().select({
    writeSpaceId: schema.connections.writeSpaceId,
    readSpaceIds: schema.connections.readSpaceIds,
  }).from(schema.connections).where(and(
    eq(schema.connections.organizationId, orgId),
    eq(schema.connections.membershipId, membershipId),
    inArray(schema.connections.state, ['pending', 'active']),
  ));
  return accessFromConnections(role, conns, spaceId);
}
