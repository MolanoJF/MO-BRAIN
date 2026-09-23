// src/control/routes/myConnection.ts
/**
 * Zones spec §5.1 — a member manages their OWN private connection's read scope.
 *
 * There is exactly one connection per (member, write Space): the client name
 * is `bs-<member8>-<spaceSlug>` and must be unique (connections.ts
 * `assertNoCollision`). So "my agent" is the private connection
 * `provisionPrivateSpace` created, and self-service is choosing which company
 * Spaces it may read — within the member's grants.
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, type Role } from '../rbac.ts';
import { callerFor, isAdminRole, type Caller } from '../zone.ts';
import { grantsFor } from '../grants.ts';
import { provisionConnection } from '../connections.ts';

export const myConnectionRoutes = new Hono();

const guard = (handler: (c: any, caller: Caller) => Promise<Response>) =>
  async (c: any) => {
    let ctx: { userId: string; orgId: string; role: Role };
    try { ctx = await requireRole(c, 'viewer'); } catch (r) { return r as Response; }
    try { return await handler(c, await callerFor(ctx)); }
    catch (e: any) { return c.json({ error: e?.message ?? 'my_connection_error' }, e?.status ?? 400); }
  };

async function mine(caller: Caller) {
  const [space] = await getDb().select().from(schema.spaces).where(and(
    eq(schema.spaces.organizationId, caller.orgId),
    eq(schema.spaces.ownerMembershipId, caller.membershipId),
  ));
  if (!space) return { space: null, connection: null };
  const [connection] = await getDb().select().from(schema.connections).where(and(
    eq(schema.connections.organizationId, caller.orgId),
    eq(schema.connections.membershipId, caller.membershipId),
    eq(schema.connections.writeSpaceId, space.id),
    inArray(schema.connections.state, ['pending', 'active']),
  ));
  return { space, connection: connection ?? null };
}

/** Company Spaces this caller may read: all of them for an admin, else granted ones. */
async function readable(caller: Caller) {
  const company = await getDb().select({ id: schema.spaces.id, sourceId: schema.spaces.sourceId, name: schema.spaces.name })
    .from(schema.spaces)
    .where(and(eq(schema.spaces.organizationId, caller.orgId), isNull(schema.spaces.ownerMembershipId)));
  if (isAdminRole(caller.role)) return company;
  const granted = new Set((await grantsFor(caller.orgId, caller.membershipId)).map((g) => g.spaceId));
  return company.filter((s) => granted.has(s.id));
}

myConnectionRoutes.get('/my/connection', guard(async (c, caller) => {
  const { space, connection } = await mine(caller);
  if (!space) return c.json({ error: 'no_private_space' }, 404);
  const reads = Array.isArray(connection?.readSpaceIds)
    ? (connection!.readSpaceIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return c.json({
    space: { id: space.id, sourceId: space.sourceId, name: space.name },
    connection: connection ? { id: connection.id, state: connection.state, readSpaceIds: reads } : null,
    readable: await readable(caller),
  });
}));

myConnectionRoutes.put('/my/connection', guard(async (c, caller) => {
  const body = await c.req.json().catch(() => ({}));
  const requested = Array.isArray(body?.readSpaceIds)
    ? [...new Set((body.readSpaceIds as unknown[]).filter((x): x is string => typeof x === 'string'))]
    : null;
  if (requested === null) return c.json({ error: 'readSpaceIds is required' }, 400);

  const { space, connection } = await mine(caller);
  if (!space || !connection) return c.json({ error: 'no_private_connection' }, 404);
  if (connection.state === 'pending') return c.json({ error: 'connection_pending' }, 409);

  const allowed = new Set((await readable(caller)).map((s) => s.id));
  if (requested.some((id) => !allowed.has(id))) return c.json({ error: 'space_not_readable' }, 400);

  await provisionConnection({
    organizationId: caller.orgId, membershipId: caller.membershipId, writeSpaceId: space.id,
    readSpaceIds: requested, harness: connection.harness, memberRole: caller.role,
    connectionId: connection.id, tokenTtl: connection.tokenTtl,
  }, caller.userId);

  await getDb().insert(schema.auditLog).values({
    id: randomUUID(), organizationId: caller.orgId, actor: caller.userId,
    action: 'connection.selfScope', target: connection.id, before: null,
    after: { readSpaces: requested.length },
  });
  return c.json({ ok: true, readSpaceIds: requested });
}));
