/**
 * Who may CHANGE a Source (schema pack, git remote, backfill, export, rename,
 * archive, remove). One rule for the unified Sources page:
 *
 * - a private Space belongs to its owner alone — an admin does not pierce it
 *   (the zone rule, `canSeeZone`);
 * - a company Space is managed by an admin or owner.
 *
 * Everyone else can see the Sources they were granted but not change them.
 */
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import { callerFor, isAdminRole, type Caller } from './zone.ts';
import type { Role } from './rbac.ts';

export type ManagedSpace = {
  id: string; sourceId: string; name: string; kind: string;
  ownerMembershipId: string | null; gitRemote: string | null;
};

export function canManageSpace(
  caller: Pick<Caller, 'role' | 'membershipId'>,
  space: { ownerMembershipId: string | null },
): boolean {
  return space.ownerMembershipId !== null
    ? space.ownerMembershipId === caller.membershipId
    : isAdminRole(caller.role);
}

/** The Space and the caller, or null when it does not exist or is not theirs to manage. */
export async function manageableSpace(
  ctx: { userId: string; orgId: string; role: Role },
  sourceId: string,
): Promise<{ caller: Caller; space: ManagedSpace } | null> {
  const caller = await callerFor(ctx);
  const [space] = await getDb().select({
    id: schema.spaces.id,
    sourceId: schema.spaces.sourceId,
    name: schema.spaces.name,
    kind: schema.spaces.kind,
    ownerMembershipId: schema.spaces.ownerMembershipId,
    gitRemote: schema.spaces.gitRemote,
  }).from(schema.spaces).where(and(
    eq(schema.spaces.organizationId, caller.orgId),
    eq(schema.spaces.sourceId, sourceId),
  ));
  if (!space || !canManageSpace(caller, space)) return null;
  return { caller, space };
}
