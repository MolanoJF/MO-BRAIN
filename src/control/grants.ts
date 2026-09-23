/**
 * `space_grants` reads and writes. The ONE place grants are created, so the
 * "company Spaces only" and "write never downgrades" rules live here once.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import type { GrantRow } from './spaceAccess.ts';
import { provisionConnection, revokeConnection } from './connections.ts';
import type { Role } from './rbac.ts';

export async function grantsFor(orgId: string, membershipId: string): Promise<GrantRow[]> {
  return getDb().select({ spaceId: schema.spaceGrants.spaceId, access: schema.spaceGrants.access })
    .from(schema.spaceGrants)
    .where(and(
      eq(schema.spaceGrants.organizationId, orgId),
      eq(schema.spaceGrants.membershipId, membershipId),
    ));
}

export async function upsertGrant(
  orgId: string, membershipId: string, spaceId: string, access: 'read' | 'write', actor: string,
): Promise<void> {
  await getDb().insert(schema.spaceGrants)
    .values({ organizationId: orgId, membershipId, spaceId, access, grantedBy: actor })
    .onConflictDoUpdate({
      target: [schema.spaceGrants.membershipId, schema.spaceGrants.spaceId],
      set: { access, grantedBy: actor },
    });
}

/**
 * An admin-created connection implies the access it compiles to: write on its
 * write Space, read on each read Space. Personal Spaces are skipped (ownership
 * is their access), and an existing `write` is never downgraded to `read`.
 */
export async function grantsForConnection(
  input: { organizationId: string; membershipId: string; writeSpaceId: string; readSpaceIds: string[] },
  actor: string,
): Promise<void> {
  const ids = [input.writeSpaceId, ...input.readSpaceIds];
  const rows = await getDb().select({ id: schema.spaces.id, owner: schema.spaces.ownerMembershipId })
    .from(schema.spaces)
    .where(and(eq(schema.spaces.organizationId, input.organizationId), inArray(schema.spaces.id, ids)));
  const company = new Set(rows.filter((r) => r.owner === null).map((r) => r.id));
  const existing = new Map(
    (await grantsFor(input.organizationId, input.membershipId)).map((g) => [g.spaceId, g.access]),
  );

  if (company.has(input.writeSpaceId)) {
    await upsertGrant(input.organizationId, input.membershipId, input.writeSpaceId, 'write', actor);
  }
  for (const id of input.readSpaceIds) {
    if (!company.has(id) || id === input.writeSpaceId || existing.get(id) === 'write') continue;
    await upsertGrant(input.organizationId, input.membershipId, id, 'read', actor);
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Removing access must remove what the access was USED for. A connection that
 * writes to the Space is revoked. A connection that only reads it is revoked,
 * too — unless it is the member's own private connection, which is rescoped to
 * drop the Space so their personal agent keeps working.
 */
export async function removeGrant(
  orgId: string, membershipId: string, spaceId: string, actor: string,
): Promise<{ removed: boolean; revoked: string[]; rescoped: string[] }> {
  const deleted = await getDb().delete(schema.spaceGrants).where(and(
    eq(schema.spaceGrants.organizationId, orgId),
    eq(schema.spaceGrants.membershipId, membershipId),
    eq(schema.spaceGrants.spaceId, spaceId),
  )).returning({ spaceId: schema.spaceGrants.spaceId });

  const [membership] = await getDb().select({ role: schema.memberships.role }).from(schema.memberships)
    .where(eq(schema.memberships.id, membershipId));
  const conns = await getDb().select().from(schema.connections).where(and(
    eq(schema.connections.organizationId, orgId),
    eq(schema.connections.membershipId, membershipId),
    inArray(schema.connections.state, ['pending', 'active']),
  ));

  const revoked: string[] = [];
  const rescoped: string[] = [];
  for (const conn of conns) {
    const reads = asStringArray(conn.readSpaceIds);
    if (conn.writeSpaceId !== spaceId && !reads.includes(spaceId)) continue;

    const [write] = await getDb().select({ owner: schema.spaces.ownerMembershipId }).from(schema.spaces)
      .where(eq(schema.spaces.id, conn.writeSpaceId));
    const ownPrivate = write?.owner === membershipId && conn.writeSpaceId !== spaceId;
    const remaining = reads.filter((id) => id !== spaceId);

    if (ownPrivate && conn.state === 'pending') {
      await getDb().update(schema.connections).set({ readSpaceIds: remaining })
        .where(eq(schema.connections.id, conn.id));
      rescoped.push(conn.id);
    } else if (ownPrivate && membership) {
      await provisionConnection({
        organizationId: orgId, membershipId, writeSpaceId: conn.writeSpaceId, readSpaceIds: remaining,
        harness: conn.harness, memberRole: membership.role as Role, connectionId: conn.id, tokenTtl: conn.tokenTtl,
      }, actor);
      rescoped.push(conn.id);
    } else {
      await revokeConnection(conn.id, actor);
      revoked.push(conn.id);
    }
  }
  return { removed: deleted.length > 0, revoked, rescoped };
}
