import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import { grantCredentialsOutPath, provisionConnection } from './connections.ts';
import { takeGrantCredentials } from './opsClient.ts';
import type { Role } from './rbac.ts';

const TTL_MS = 24 * 60 * 60 * 1000;

export type ClaimResult = {
  membershipId: string;
  connections: Array<{ connectionId: string; credentials: unknown }>;
};

/** Email is case-normalized to lowercase so a leaked link still needs the matching address. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function asRole(value: string): Role {
  if (value === 'owner' || value === 'admin' || value === 'member' || value === 'viewer') return value;
  throw new Error(`invalid membership role ${value}`);
}

/** Returns the raw token ONCE. Only sha256(token) is persisted. */
export async function mintClaimLink(
  orgId: string,
  membershipId: string,
  email: string,
  actor: string,
): Promise<{ token: string; expiresAt: Date }> {
  await assertMembership(orgId, membershipId);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TTL_MS);
  const normalized = normalizeEmail(email);

  await getDb().transaction(async (tx) => {
    await tx.delete(schema.claimLinks).where(and(
      eq(schema.claimLinks.membershipId, membershipId),
      eq(schema.claimLinks.organizationId, orgId),
      isNull(schema.claimLinks.claimedAt),
    ));
    await tx.insert(schema.claimLinks).values({
      id: randomUUID(),
      organizationId: orgId,
      membershipId,
      email: normalized,
      tokenHash,
      expiresAt,
      createdBy: actor,
    });
  });

  return { token, expiresAt };
}

/**
 * Burn-on-fetch: the claim is marked consumed in the SAME statement that selects
 * it, so two concurrent requests cannot both succeed.
 */
export async function claim(token: string, email: string): Promise<ClaimResult> {
  const hash = hashToken(token);
  const normalized = normalizeEmail(email);

  // Email is in the predicate so a leaked link + wrong address does not consume.
  const updated = [...await getDb().execute<{
    id: string;
    organization_id: string;
    membership_id: string;
    email: string;
    token_hash: string;
    expires_at: Date;
    claimed_at: Date | null;
    created_by: string;
    created_at: Date;
  }>(sql`
    UPDATE claim_links
    SET claimed_at = now()
    WHERE token_hash = ${hash}
      AND claimed_at IS NULL
      AND expires_at > now()
      AND lower(email) = ${normalized}
    RETURNING *
  `)];

  const burned = updated[0];
  if (!burned) return await rejectFailedClaim(hash, normalized);

  const membershipId = burned.membership_id;
  const organizationId = burned.organization_id;
  const [membership] = await getDb().select().from(schema.memberships)
    .where(eq(schema.memberships.id, membershipId));
  if (!membership) throw new Error(`membership ${membershipId} not found`);
  const memberRole = asRole(membership.role);

  const pending = await getDb().select().from(schema.connections).where(and(
    eq(schema.connections.membershipId, membershipId),
    eq(schema.connections.state, 'pending'),
  ));

  const connections: ClaimResult['connections'] = [];
  for (const row of pending) {
    const prefixes = Array.isArray(row.boundSlugPrefixes)
      ? row.boundSlugPrefixes.filter((x): x is string => typeof x === 'string')
      : undefined;
    const provisioned = await provisionConnection({
      organizationId,
      membershipId,
      writeSpaceId: row.writeSpaceId,
      readSpaceIds: asStringArray(row.readSpaceIds),
      harness: row.harness,
      memberRole,
      connectionId: row.id,
      boundSlugPrefixes: prefixes,
      tokenTtl: row.tokenTtl,
      budgetUsdPerDay: row.budgetUsdPerDay != null ? Number(row.budgetUsdPerDay) : undefined,
    }, membership.userId);
    const credentials = await takeGrantCredentials(grantCredentialsOutPath(provisioned.connectionId));
    connections.push({ connectionId: provisioned.connectionId, credentials });
  }

  return { membershipId, connections };
}

async function rejectFailedClaim(hash: string, email: string): Promise<never> {
  const [row] = await getDb().select().from(schema.claimLinks)
    .where(eq(schema.claimLinks.tokenHash, hash));
  if (!row) throw new Error('claim link invalid');
  if (row.claimedAt) throw new Error('claim link already used');
  if (row.expiresAt.getTime() <= Date.now()) throw new Error('claim link expired');
  if (normalizeEmail(row.email) !== email) throw new Error('claim email does not match');
  throw new Error('claim link invalid');
}

async function assertMembership(orgId: string, membershipId: string): Promise<void> {
  const [row] = await getDb().select({ id: schema.memberships.id }).from(schema.memberships)
    .where(and(
      eq(schema.memberships.id, membershipId),
      eq(schema.memberships.organizationId, orgId),
    ));
  if (!row) throw new Error(`membership ${membershipId} not found`);
}
