/**
 * Stored credentials the console manages: GitHub tokens (one per member, one
 * for the company) and the model-provider keys. Everything lives in the
 * encrypted `secrets` table; this module only NAMES them and answers "which
 * token does this Space use?". Nothing here logs or returns a value.
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import { readSecret } from './secrets.ts';

/** The company-wide GitHub token: used for company Space remotes. */
export const GITHUB_ORG_SECRET = 'github_token';
/** One GitHub token per member: used for that member's private Space remote. */
export const githubMemberSecret = (membershipId: string) => `github_token:member:${membershipId}`;

/**
 * Which GitHub token a Space's remote uses. An explicit token (the legacy
 * per-remote field) wins; a private Space uses its owner's member token; a
 * company Space uses the org token. Null when none is stored.
 */
export async function resolveGithubToken(args: {
  orgId: string;
  space: { ownerMembershipId: string | null };
  explicitToken?: string | null;
}): Promise<{ token: string; secretName: string | null } | null> {
  const explicit = args.explicitToken?.trim();
  if (explicit) return { token: explicit, secretName: null };
  const secretName = args.space.ownerMembershipId
    ? githubMemberSecret(args.space.ownerMembershipId)
    : GITHUB_ORG_SECRET;
  const token = (await readSecret(args.orgId, secretName))?.trim();
  return token ? { token, secretName } : null;
}

export type CredentialStatus = { configured: boolean; updatedAt: string | null; version: number | null };

/** Whether each named secret exists, and when. Selects metadata only: the payload is never read or decrypted. */
export async function credentialStatus(orgId: string, names: string[]): Promise<Record<string, CredentialStatus>> {
  const out: Record<string, CredentialStatus> = {};
  for (const name of names) {
    const [row] = await getDb()
      .select({ version: schema.secrets.version, createdAt: schema.secrets.createdAt })
      .from(schema.secrets)
      .where(and(eq(schema.secrets.organizationId, orgId), eq(schema.secrets.name, name)))
      .orderBy(desc(schema.secrets.version)).limit(1);
    out[name] = row
      ? { configured: true, updatedAt: row.createdAt.toISOString(), version: row.version }
      : { configured: false, updatedAt: null, version: null };
  }
  return out;
}
