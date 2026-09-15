import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import { auth } from './auth.ts';

export async function isBootstrapped(): Promise<boolean> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.organizations);
  return (row?.n ?? 0) > 0;
}

/**
 * Creates the first admin, their org, and an UNINITIALIZED brain row. The
 * brain becomes real only when the wizard runs `gbrain init` — the image
 * ships uninitialized because on Postgres the database does not exist at
 * build time.
 */
export async function bootstrapFirstAdmin(email: string, password: string, orgName: string) {
  if (await isBootstrapped()) throw new Error('already_bootstrapped');

  const signed = await auth.api.signUpEmail({ body: { email, password, name: email } });
  const userId = (signed as { user?: { id?: string } }).user?.id;
  if (!userId) throw new Error('sign_up_failed');

  const orgId = randomUUID();
  const brainId = randomUUID();
  const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org';

  const db = getDb();
  await db.insert(schema.organizations).values({ id: orgId, name: orgName, slug, brainMode: 'company' });
  await db.insert(schema.memberships).values({ id: randomUUID(), userId, organizationId: orgId, role: 'owner' });
  await db.insert(schema.brains).values({
    id: brainId, organizationId: orgId,
    gbrainHome: process.env.GBRAIN_HOME ?? '/srv/gbrain-home',
    engine: 'postgres', gbrainVersion: process.env.GBRAIN_VERSION ?? null,
    lifecycle: 'uninitialized',
  });
  await db.insert(schema.auditLog).values({
    id: randomUUID(), organizationId: orgId, actor: userId,
    action: 'bootstrap', target: orgId, before: null, after: { orgName, slug },
  });

  return { userId, orgId, brainId };
}
