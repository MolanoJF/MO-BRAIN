// src/control/inviteAccount.ts
/**
 * Zones plan 3 — the ONE place a claim touches credentials.
 *
 * Only an account an invite created (`invite_placeholder`) may have its
 * password set here: its password is random and nobody knows it. Any other
 * account belongs to a person who already chose a password, and a claim link
 * (which an admin can mint for any email) must never be a way to replace it.
 *
 * The hash is Better Auth's own `hashPassword`, the same function its
 * email/password sign-in verifies against, written to the `credential` account
 * row sign-up created.
 */
import { and, eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { getDb, schema } from './db/client.ts';

export async function setInvitePassword(userId: string, password: string): Promise<'created' | 'existing'> {
  const [user] = await getDb().select({ placeholder: schema.users.invitePlaceholder })
    .from(schema.users).where(eq(schema.users.id, userId));
  if (!user?.placeholder) return 'existing';

  const hash = await hashPassword(password);
  const updated = await getDb().update(schema.accounts)
    .set({ password: hash, updatedAt: new Date() })
    .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.providerId, 'credential')))
    .returning({ id: schema.accounts.id });
  if (updated.length === 0) throw new Error('credential_account_missing');

  await getDb().update(schema.users)
    .set({ invitePlaceholder: false, emailVerified: true, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
  return 'created';
}
