import type { Sql } from './db/index.ts';
import { newToken, sha256Hex } from './crypto.ts';
import type { User } from './types.ts';

const SESSION_DAYS = 30;

export const hashPassword = (pw: string) => Bun.password.hash(pw, { algorithm: 'argon2id' });

export async function loginWithPassword(sql: Sql, email: string, password: string): Promise<User | null> {
  const [row] = await sql<(User & { passwordHash: string | null })[]>`
    select id, email, name, role, status, created_at, password_hash from users where email = ${email}`;
  if (!row || row.status !== 'active' || !row.passwordHash) return null;
  if (!(await Bun.password.verify(password, row.passwordHash))) return null;
  const { passwordHash: _, ...user } = row;
  return user;
}

export async function createSession(sql: Sql, userId: string, now: Date): Promise<string> {
  const token = newToken();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  await sql`insert into sessions (id_hash, user_id, expires_at) values (${sha256Hex(token)}, ${userId}, ${expires})`;
  return token;
}

export async function userForSession(sql: Sql, token: string, now: Date): Promise<User | null> {
  const [row] = await sql<User[]>`
    select u.id, u.email, u.name, u.role, u.status, u.created_at
    from sessions s join users u on u.id = s.user_id
    where s.id_hash = ${sha256Hex(token)} and s.expires_at > ${now} and u.status = 'active'`;
  return row ?? null;
}

export async function deleteSession(sql: Sql, token: string): Promise<void> {
  await sql`delete from sessions where id_hash = ${sha256Hex(token)}`;
}

export async function createApiKey(sql: Sql, userId: string, label: string): Promise<string> {
  const key = `mbk_${newToken()}`;
  await sql`insert into api_keys (key_hash, user_id, label) values (${sha256Hex(key)}, ${userId}, ${label})`;
  return key;
}

export async function userForApiKey(sql: Sql, key: string): Promise<User | null> {
  const [row] = await sql<User[]>`
    select u.id, u.email, u.name, u.role, u.status, u.created_at
    from api_keys k join users u on u.id = k.user_id
    where k.key_hash = ${sha256Hex(key)} and k.revoked_at is null and u.status = 'active'`;
  return row ?? null;
}

/** In-memory failed-login counter: 10 failures per email per 15 minutes. */
export class LoginThrottle {
  private fails = new Map<string, number[]>();
  private window = 15 * 60_000;
  fail(email: string, now: number) {
    const k = email.toLowerCase();
    this.fails.set(k, [...(this.fails.get(k) ?? []).filter((t) => now - t < this.window), now]);
  }
  locked(email: string, now: number): boolean {
    return (this.fails.get(email.toLowerCase()) ?? []).filter((t) => now - t < this.window).length >= 10;
  }
  clear(email: string) { this.fails.delete(email.toLowerCase()); }
}
