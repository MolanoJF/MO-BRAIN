import { Hono } from 'hono';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, type Role } from '../rbac.ts';
import { auth } from '../auth.ts';
import { mintClaimLink } from '../claim.ts';
import { revokeConnection } from '../connections.ts';
import { accessFromConnections } from '../spaceAccess.ts';

export const members = new Hono();

const ASSIGNABLE: Role[] = ['admin', 'member', 'viewer'];

async function audit(orgId: string, actor: string, action: string, target: string, after: unknown) {
  // S3c: `after` is a redacted summary — never a raw request body.
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target, before: null, after: after as object });
}

const guard = (min: Role, handler: (c: any, ctx: { userId: string; orgId: string; role: Role }) => Promise<Response>) =>
  async (c: any) => {
    let ctx;
    try { ctx = await requireRole(c, min); } catch (r) { return r as Response; }
    try { return await handler(c, ctx); }
    catch (e: any) { return c.json({ error: e?.message ?? 'members_error' }, e?.status ?? 400); }
  };

function isAssignableRole(value: unknown): value is Role {
  return typeof value === 'string' && (ASSIGNABLE as string[]).includes(value);
}

members.get('/members', guard('admin', async (c, { orgId }) => {
  const rows = await getDb()
    .select({
      id: schema.memberships.id,
      userId: schema.memberships.userId,
      role: schema.memberships.role,
      createdAt: schema.memberships.createdAt,
      email: schema.users.email,
      name: schema.users.name,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .where(eq(schema.memberships.organizationId, orgId));
  return c.json({ members: rows });
}));

members.post('/members', guard('admin', async (c, { userId, orgId }) => {
  const body = await c.req.json();
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = body?.role;
  if (!email || !email.includes('@')) return c.json({ error: 'email is required' }, 400);
  if (!isAssignableRole(role)) return c.json({ error: 'role must be admin, member, or viewer' }, 400);

  // Password-less invite: Better Auth still requires a password column, so we
  // generate a random unusable password. The member path is the claim link.
  let targetUserId: string;
  const [existing] = await getDb().select().from(schema.users).where(eq(schema.users.email, email));
  if (existing) {
    targetUserId = existing.id;
  } else {
    const password = randomBytes(32).toString('base64url');
    const signed = await auth.api.signUpEmail({ body: { email, password, name: email } });
    const id = (signed as { user?: { id?: string } }).user?.id;
    if (!id) throw new Error('sign_up_failed');
    targetUserId = id;
  }

  const [dup] = await getDb().select({ id: schema.memberships.id }).from(schema.memberships)
    .where(and(eq(schema.memberships.userId, targetUserId), eq(schema.memberships.organizationId, orgId)));
  if (dup) return c.json({ error: 'already a member' }, 409);

  const membershipId = randomUUID();
  await getDb().insert(schema.memberships).values({
    id: membershipId, userId: targetUserId, organizationId: orgId, role,
  });
  await audit(orgId, userId, 'member.create', membershipId, { role });
  return c.json({ id: membershipId, userId: targetUserId, email, role });
}));

members.delete('/members/:id', guard('admin', async (c, { userId, orgId }) => {
  const id = c.req.param('id');
  const [membership] = await getDb().select().from(schema.memberships)
    .where(and(eq(schema.memberships.id, id), eq(schema.memberships.organizationId, orgId)));
  if (!membership) return c.json({ error: 'member not found' }, 404);
  if (membership.userId === userId) return c.json({ error: 'cannot offboard yourself' }, 400);

  if (membership.role === 'owner') {
    const owners = await getDb().select({ id: schema.memberships.id }).from(schema.memberships)
      .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.role, 'owner')));
    if (owners.length <= 1) return c.json({ error: 'cannot offboard the last owner' }, 400);
  }

  const conns = await getDb().select().from(schema.connections)
    .where(eq(schema.connections.membershipId, id));
  let revoked = 0;
  for (const conn of conns) {
    if (conn.state === 'revoked') continue;
    await revokeConnection(conn.id, userId);
    revoked += 1;
  }

  // Spaces outlive the member (S4b). v1 always orphans; never delete the gbrain source.
  await getDb().delete(schema.memberships).where(eq(schema.memberships.id, id));
  await audit(orgId, userId, 'member.offboard', id, { revoked, spaces: 'orphaned' });
  return c.json({ revoked, spaces: 'orphaned' });
}));

members.post('/members/:id/claim-link', guard('admin', async (c, { userId, orgId }) => {
  const id = c.req.param('id');
  const [membership] = await getDb().select().from(schema.memberships)
    .where(and(eq(schema.memberships.id, id), eq(schema.memberships.organizationId, orgId)));
  if (!membership) return c.json({ error: 'member not found' }, 404);

  const [user] = await getDb().select().from(schema.users).where(eq(schema.users.id, membership.userId));
  let email = user?.email ?? '';
  try {
    const body = await c.req.json();
    if (body && typeof body.email === 'string') email = body.email;
  } catch { /* empty body → user's email */ }
  if (!email) return c.json({ error: 'email is required' }, 400);

  const minted = await mintClaimLink(orgId, id, email, userId);
  await audit(orgId, userId, 'member.claimLink', id, { expiresAt: minted.expiresAt.toISOString() });
  return c.json({ token: minted.token, expiresAt: minted.expiresAt.toISOString() });
}));

members.get('/access-overview', guard('viewer', async (c, { orgId }) => {
  const memberRows = await getDb()
    .select({
      membershipId: schema.memberships.id,
      email: schema.users.email,
      role: schema.memberships.role,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .where(eq(schema.memberships.organizationId, orgId));

  const spaces = await getDb().select({
    id: schema.spaces.id,
    sourceId: schema.spaces.sourceId,
    name: schema.spaces.name,
  }).from(schema.spaces).where(eq(schema.spaces.organizationId, orgId));

  const conns = await getDb().select().from(schema.connections)
    .where(and(
      eq(schema.connections.organizationId, orgId),
      inArray(schema.connections.state, ['pending', 'active']),
    ));

  // ONE derivation, shared with the Files routes: admin/owner show `write` on
  // every Space in the org, and a member's cells come only from their
  // connections. Grouping is just to avoid re-scanning every connection per
  // (member, Space) pair.
  const connsByMembership = new Map<string, typeof conns>();
  for (const conn of conns) {
    const list = connsByMembership.get(conn.membershipId);
    if (list) list.push(conn); else connsByMembership.set(conn.membershipId, [conn]);
  }

  const cells: Array<{ membershipId: string; spaceId: string; access: 'read' | 'write' }> = [];
  for (const member of memberRows) {
    const memberConns = connsByMembership.get(member.membershipId) ?? [];
    for (const space of spaces) {
      const access = accessFromConnections(member.role as Role, memberConns, space.id);
      if (access !== null) cells.push({ membershipId: member.membershipId, spaceId: space.id, access });
    }
  }

  return c.json({ members: memberRows, spaces, cells });
}));
