/**
 * The zone rule (spec §4) — the ONE derivation of "whose is this, and may the
 * caller see it". A Space's zone is its owner (`owner_membership_id`): set means
 * personal, null means company. Connections, schedules, runs and alerts have no
 * zone of their own; they inherit the zone of the Space they WRITE to.
 *
 * `canSeeZone` is the pure rule; `visibleZoneSql` is its SQL twin for list
 * queries. The two must agree — test/integration/zones.test.ts exercises the
 * SQL form against every role the unit test pins for the pure one.
 *
 * `Role` is a type-only import on purpose: importing a VALUE from rbac.ts
 * would load Better Auth at module init, which unit tests must not need.
 */
import { and, eq, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import type { Role } from './rbac.ts';
import { getDb, schema } from './db/client.ts';

export type Zone = { kind: 'personal'; ownerMembershipId: string } | { kind: 'company' };

export type Caller = { userId: string; orgId: string; role: Role; membershipId: string };

export function zoneOf(ownerMembershipId: string | null): Zone {
  return ownerMembershipId === null
    ? { kind: 'company' }
    : { kind: 'personal', ownerMembershipId };
}

export function isAdminRole(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * `writeSpace` is the Space the object writes to, or `null` when none resolves
 * (a schedule whose connection was set-null'd, a run whose connection was
 * deleted). Nobody can prove an unresolved object was theirs, so it is company
 * zone and admin-only. A personal zone is its owner's alone — the admin/owner
 * override does NOT pierce it.
 */
export function canSeeZone(
  caller: Pick<Caller, 'role' | 'membershipId'>,
  writeSpace: { ownerMembershipId: string | null } | null,
): boolean {
  if (writeSpace === null) return isAdminRole(caller.role);
  if (writeSpace.ownerMembershipId !== null) return writeSpace.ownerMembershipId === caller.membershipId;
  return true;
}

/**
 * The SQL twin of `canSeeZone`, for a query that LEFT JOINs `schema.spaces` as
 * the write Space. On a LEFT JOIN miss both `spaces.id` and
 * `spaces.owner_membership_id` are null, so "company" must also require a
 * resolved row — otherwise an unresolved object would read as company for
 * everyone.
 */
export function visibleZoneSql(caller: Pick<Caller, 'role' | 'membershipId'>): SQL {
  const own = eq(schema.spaces.ownerMembershipId, caller.membershipId);
  const company = and(isNotNull(schema.spaces.id), isNull(schema.spaces.ownerMembershipId))!;
  return isAdminRole(caller.role)
    ? or(own, company, isNull(schema.spaces.id))!
    : or(own, company)!;
}

/** `requireRole` returns no membership id; every zone check needs one. */
export async function callerFor(ctx: { userId: string; orgId: string; role: Role }): Promise<Caller> {
  const [m] = await getDb().select({ id: schema.memberships.id }).from(schema.memberships)
    .where(and(
      eq(schema.memberships.userId, ctx.userId),
      eq(schema.memberships.organizationId, ctx.orgId),
    ));
  if (!m) throw Object.assign(new Error('forbidden'), { status: 403 });
  return { ...ctx, membershipId: m.id };
}
