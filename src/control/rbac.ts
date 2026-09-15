import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { auth } from './auth.ts';
import { getDb, schema } from './db/client.ts';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

function isRole(value: string): value is Role {
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, value);
}

function throwStatus(status: 401 | 403, error: 'unauthorized' | 'forbidden'): never {
  throw new Response(JSON.stringify({ error }), {
    status, headers: { 'content-type': 'application/json' },
  });
}

/** Throws a Response on 401/403 — callers use the `guard` wrapper from routes/wizard.ts:60. */
export async function requireRole(c: Context, min: Role): Promise<{ userId: string; orgId: string; role: Role }> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const userId = session?.user?.id;
  if (!userId) throwStatus(401, 'unauthorized');

  // Read from our column, not Better Auth's session payload (organization
  // plugin was dropped; getSession does not carry activeOrganizationId).
  const sessionId = session.session.id;
  const [sess] = await getDb()
    .select({ activeOrganizationId: schema.sessions.activeOrganizationId })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId));
  const activeOrgId = sess?.activeOrganizationId ?? null;

  const memberships = activeOrgId
    ? await getDb().select().from(schema.memberships).where(and(
      eq(schema.memberships.userId, userId),
      eq(schema.memberships.organizationId, activeOrgId),
    ))
    : await getDb().select().from(schema.memberships).where(eq(schema.memberships.userId, userId));

  const m = activeOrgId
    ? memberships[0]
    : memberships.length === 1 ? memberships[0] : undefined;

  if (!m || !isRole(m.role) || ROLE_RANK[m.role] < ROLE_RANK[min]) {
    throwStatus(403, 'forbidden');
  }
  return { userId, orgId: m.organizationId, role: m.role };
}
