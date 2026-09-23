/**
 * `space_grants` reads and writes. The ONE place grants are created, so the
 * "company Spaces only" and "write never downgrades" rules live here once.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import type { GrantRow } from './spaceAccess.ts';

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
