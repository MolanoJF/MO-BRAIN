/**
 * S1 — the ONE derivation of "can this membership touch this Space, and how".
 *
 * The Access matrix (`/access-overview`) and the Files routes both call this,
 * so a cell the page renders as `read` is exactly a read the Files browser
 * will allow.
 *
 * Zones spec D7: access to a COMPANY Space comes from `space_grants`, not from
 * connection rows. A personal Space (`ownerMembershipId` non-null) is `write`
 * for its owner and `null` for everyone else — the admin/owner override does
 * not pierce it, and no grant can either.
 */
import { and, eq } from 'drizzle-orm';
import type { Role } from './rbac.ts';
import { getDb, schema } from './db/client.ts';
import { grantsFor } from './grants.ts';

export type GrantRow = { spaceId: string; access: string };

export function accessFromGrants(
  role: Role,
  grants: readonly GrantRow[],
  spaceId: string,
  ownerMembershipId: string | null,
  requestingMembershipId: string,
): 'write' | 'read' | null {
  if (ownerMembershipId !== null) return ownerMembershipId === requestingMembershipId ? 'write' : null;
  if (role === 'admin' || role === 'owner') return 'write';
  const grant = grants.find((g) => g.spaceId === spaceId);
  if (grant?.access === 'write') return 'write';
  if (grant?.access === 'read') return 'read';
  return null;
}

/** DB-backed. Scoped to the org as well as the membership. */
export async function spaceAccess(
  orgId: string,
  membershipId: string,
  role: Role,
  spaceId: string,
): Promise<'write' | 'read' | null> {
  const [space] = await getDb().select({ ownerMembershipId: schema.spaces.ownerMembershipId })
    .from(schema.spaces).where(and(eq(schema.spaces.organizationId, orgId), eq(schema.spaces.id, spaceId)));
  if (!space) return null;
  return accessFromGrants(role, await grantsFor(orgId, membershipId), spaceId, space.ownerMembershipId, membershipId);
}
