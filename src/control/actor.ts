import { eq } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';

/** The acting admin's identity, from the session's user row — never a body. */
export async function actorIdentity(userId: string): Promise<{ name: string; email: string }> {
  const [user] = await getDb().select({ name: schema.users.name, email: schema.users.email })
    .from(schema.users).where(eq(schema.users.id, userId));
  if (!user) throw Object.assign(new Error('actor_unknown'), { status: 401 });
  return { name: user.name ?? user.email, email: user.email };
}
