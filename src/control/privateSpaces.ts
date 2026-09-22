import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import { provisionConnection } from './connections.ts';
import type { Role } from './rbac.ts';

/** Deterministic, collision-free per membership. Mirrors `clientName`'s bs-<memberId8>-<slug>. */
export function privateSpaceSourceId(membershipId: string): string {
  return `my-space-${membershipId.slice(0, 8).toLowerCase()}`;
}

export const PRIVATE_SPACE_HARNESS = 'generic';

export type ProvisionPrivateSpaceResult =
  | { ok: true; spaceId: string; sourceId: string; connectionId: string }
  | { ok: false; error: string; status: 400 | 404 | 409 };

async function audit(orgId: string, actor: string, action: string, target: string, after: unknown) {
  // S3c: `after` is a redacted summary — never a raw request body.
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target, before: null, after: after as object });
}

export async function provisionPrivateSpace(
  orgId: string,
  membershipId: string,
  actor: string,
): Promise<ProvisionPrivateSpaceResult> {
  const [org] = await getDb()
    .select({ privateSpacesEnabled: schema.organizations.privateSpacesEnabled })
    .from(schema.organizations).where(eq(schema.organizations.id, orgId));
  if (!org) return { ok: false, error: 'organization_not_found', status: 404 };
  if (!org.privateSpacesEnabled) return { ok: false, error: 'private_spaces_disabled', status: 409 };

  const [membership] = await getDb()
    .select({ id: schema.memberships.id, role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.id, membershipId), eq(schema.memberships.organizationId, orgId)));
  if (!membership) return { ok: false, error: 'member_not_found', status: 404 };

  let [space] = await getDb().select().from(schema.spaces).where(and(
    eq(schema.spaces.organizationId, orgId),
    eq(schema.spaces.ownerMembershipId, membershipId),
  ));

  if (!space) {
    const sourceId = privateSpaceSourceId(membershipId);
    try {
      await getDb().insert(schema.spaces).values({
        id: randomUUID(),
        organizationId: orgId,
        sourceId,
        name: 'My Space',
        kind: 'local-git',
        localPath: `/srv/brain-repos/${sourceId}`,
        ownerMembershipId: membershipId,
      });
    } catch (e) {
      // A concurrent invite/retry raced us to the partial unique index; the row
      // it created is the one we want.
      if (!isUniqueViolation(e)) throw e;
    }
    [space] = await getDb().select().from(schema.spaces).where(and(
      eq(schema.spaces.organizationId, orgId),
      eq(schema.spaces.ownerMembershipId, membershipId),
    ));
  }
  if (!space) throw new Error('private_space_insert_failed');

  const [active] = await getDb().select().from(schema.connections).where(and(
    eq(schema.connections.organizationId, orgId),
    eq(schema.connections.membershipId, membershipId),
    eq(schema.connections.writeSpaceId, space.id),
    eq(schema.connections.state, 'active'),
  ));
  if (active) {
    return { ok: true, spaceId: space.id, sourceId: space.sourceId, connectionId: active.id };
  }

  const [pending] = await getDb().select({ id: schema.connections.id }).from(schema.connections).where(and(
    eq(schema.connections.organizationId, orgId),
    eq(schema.connections.membershipId, membershipId),
    eq(schema.connections.writeSpaceId, space.id),
    eq(schema.connections.state, 'pending'),
  ));

  // `privateSpace: true` is derived inside connections.ts from the write Space's
  // ownerMembershipId; never passed here.
  const provisioned = await provisionConnection({
    organizationId: orgId,
    membershipId,
    writeSpaceId: space.id,
    readSpaceIds: [],
    harness: PRIVATE_SPACE_HARNESS,
    memberRole: membership.role as Role,
    ...(pending ? { connectionId: pending.id } : {}),
  }, actor);

  await audit(orgId, actor, 'member.privateSpace', space.id, {
    sourceId: space.sourceId,
    connectionId: provisioned.connectionId,
  });

  return { ok: true, spaceId: space.id, sourceId: space.sourceId, connectionId: provisioned.connectionId };
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; errno?: string; cause?: { code?: string; errno?: string } };
  const code = err.errno ?? err.code ?? err.cause?.errno ?? err.cause?.code;
  return code === '23505';
}
