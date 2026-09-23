import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import { auth } from './auth.ts';

export async function isBootstrapped(): Promise<boolean> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.organizations);
  return (row?.n ?? 0) > 0;
}

/** Zones spec D6: the pack gbrain itself recommends, stored explicitly so the
 *  Schema tab shows it and `diverged` checks have a stored value to compare. */
export const DEFAULT_SCHEMA_PACK = 'gbrain-base-v2';

export function defaultBrainName(email: string): string {
  const local = email.split('@')[0]?.trim() || 'My';
  return `${local}'s brain`;
}

/**
 * Shared by both bootstrap paths (D2): creates the org, owner membership,
 * UNINITIALIZED brain row, and audit entry for an ALREADY-EXISTING user. The
 * brain becomes real only when the wizard runs `gbrain init` — the image
 * ships uninitialized because on Postgres the database does not exist at
 * build time.
 *
 * Zones spec D6: a fresh install is a PERSONAL brain. `opts.brainMode` exists
 * for test setups that exercise team routes; neither HTTP route passes it.
 */
async function createOrgForNewAdmin(
  userId: string, orgName: string,
  opts: { brainMode?: 'personal' | 'company' } = {},
) {
  const orgId = randomUUID();
  const brainId = randomUUID();
  const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org';
  const brainMode = opts.brainMode ?? 'personal';

  const db = getDb();
  await db.insert(schema.organizations).values({ id: orgId, name: orgName, slug, brainMode });
  await db.insert(schema.memberships).values({ id: randomUUID(), userId, organizationId: orgId, role: 'owner' });
  await db.insert(schema.brains).values({
    id: brainId, organizationId: orgId,
    gbrainHome: process.env.GBRAIN_HOME ?? '/srv/gbrain-home',
    engine: 'postgres', gbrainVersion: process.env.GBRAIN_VERSION ?? null,
    lifecycle: 'uninitialized',
    schemaPack: DEFAULT_SCHEMA_PACK,
  });
  await db.insert(schema.auditLog).values({
    id: randomUUID(), organizationId: orgId, actor: userId,
    action: 'bootstrap', target: orgId, before: null, after: { orgName, slug, brainMode },
  });

  return { userId, orgId, brainId };
}

/**
 * Password path: creates the user, then the org. Every existing caller of
 * this exact name/signature keeps working with no edits — D2.
 */
export async function bootstrapFirstAdmin(
  email: string, password: string, orgName: string,
  opts: { brainMode?: 'personal' | 'company' } = {},
) {
  if (await isBootstrapped()) throw new Error('already_bootstrapped');

  const signed = await auth.api.signUpEmail({ body: { email, password, name: email } });
  const userId = (signed as { user?: { id?: string } }).user?.id;
  if (!userId) throw new Error('sign_up_failed');

  return createOrgForNewAdmin(userId, orgName, opts);
}

/**
 * Google path (D2): the caller already has a session (they completed
 * sign-in/social in the browser before POSTing here) — nothing left to do
 * but create the org for that existing user.
 */
export async function bootstrapFirstAdminForSession(
  userId: string, orgName: string,
  opts: { brainMode?: 'personal' | 'company' } = {},
) {
  if (await isBootstrapped()) throw new Error('already_bootstrapped');
  return createOrgForNewAdmin(userId, orgName, opts);
}
