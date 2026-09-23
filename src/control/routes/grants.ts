// src/control/routes/grants.ts
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, type Role } from '../rbac.ts';
import { removeGrant, upsertGrant } from '../grants.ts';
import { requireCapability } from '../capabilities.ts';

export const grantRoutes = new Hono();

const guard = (min: Role, handler: (c: any, ctx: { userId: string; orgId: string; role: Role }) => Promise<Response>) =>
  async (c: any) => {
    let ctx;
    try { ctx = await requireRole(c, min); } catch (r) { return r as Response; }
    try { return await handler(c, ctx); }
    catch (e: any) { return c.json({ error: e?.message ?? 'grants_error' }, e?.status ?? 400); }
  };

async function audit(orgId: string, actor: string, action: string, target: string, after: unknown) {
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target, before: null, after: after as object });
}

async function readTarget(c: any, orgId: string) {
  const body = await c.req.json().catch(() => ({}));
  const membershipId = typeof body?.membershipId === 'string' ? body.membershipId : '';
  const spaceId = typeof body?.spaceId === 'string' ? body.spaceId : '';
  const [membership] = await getDb().select({ id: schema.memberships.id }).from(schema.memberships)
    .where(and(eq(schema.memberships.id, membershipId), eq(schema.memberships.organizationId, orgId)));
  if (!membership) throw Object.assign(new Error('member_not_found'), { status: 404 });
  const [space] = await getDb().select({ owner: schema.spaces.ownerMembershipId }).from(schema.spaces)
    .where(and(eq(schema.spaces.id, spaceId), eq(schema.spaces.organizationId, orgId)));
  // A personal Space answers exactly like a missing one would to anyone but
  // its owner — but an admin granting it is a programming error worth naming.
  if (!space) throw Object.assign(new Error('space_not_found'), { status: 404 });
  if (space.owner !== null) throw Object.assign(new Error('personal_space_not_grantable'), { status: 400 });
  return { body, membershipId, spaceId };
}

grantRoutes.get('/grants', guard('admin', async (c, { orgId }) => {
  const grants = await getDb().select({
    membershipId: schema.spaceGrants.membershipId,
    spaceId: schema.spaceGrants.spaceId,
    access: schema.spaceGrants.access,
  }).from(schema.spaceGrants)
    .innerJoin(schema.spaces, eq(schema.spaces.id, schema.spaceGrants.spaceId))
    .where(and(eq(schema.spaceGrants.organizationId, orgId), isNull(schema.spaces.ownerMembershipId)));
  return c.json({ grants });
}));

grantRoutes.put('/grants', guard('admin', async (c, { userId, orgId }) => {
  await requireCapability(orgId, 'grants');
  const { body, membershipId, spaceId } = await readTarget(c, orgId);
  const access = body?.access;
  if (access !== 'read' && access !== 'write') return c.json({ error: 'invalid_access' }, 400);
  await upsertGrant(orgId, membershipId, spaceId, access, userId);
  await audit(orgId, userId, 'grant.put', membershipId, { spaceId, access });
  return c.json({ ok: true });
}));

grantRoutes.delete('/grants', guard('admin', async (c, { userId, orgId }) => {
  await requireCapability(orgId, 'grants');
  const { membershipId, spaceId } = await readTarget(c, orgId);
  const result = await removeGrant(orgId, membershipId, spaceId, userId);
  await audit(orgId, userId, 'grant.delete', membershipId, {
    spaceId, revoked: result.revoked.length, rescoped: result.rescoped.length,
  });
  return c.json(result);
}));
