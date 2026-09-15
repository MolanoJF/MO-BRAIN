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

type SessionPayload = {
  user?: { id?: string };
  session?: { activeOrganizationId?: string | null };
} | null;

/** Throws a Response on 401/403 — callers use the `guard` wrapper from routes/wizard.ts:60. */
export async function requireRole(c: Context, min: Role): Promise<{ userId: string; orgId: string; role: Role }> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers }) as SessionPayload;
  const userId = session?.user?.id;
  if (!userId) throwStatus(401, 'unauthorized');

  const activeOrgId = session?.session?.activeOrganizationId ?? null;
  const db = getDb();

  const memberships = activeOrgId
    ? await db.select().from(schema.memberships).where(and(
      eq(schema.memberships.userId, userId),
      eq(schema.memberships.organizationId, activeOrgId),
    ))
    : await db.select().from(schema.memberships).where(eq(schema.memberships.userId, userId));

  const m = activeOrgId
    ? memberships[0]
    : memberships.length === 1 ? memberships[0] : undefined;

  if (!m || !isRole(m.role) || ROLE_RANK[m.role] < ROLE_RANK[min]) {
    throwStatus(403, 'forbidden');
  }
  return { userId, orgId: m.organizationId, role: m.role };
}
