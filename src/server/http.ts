import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Role, User } from './types.ts';
import type { Sql } from './db/index.ts';
import { userForApiKey, userForSession } from './auth.ts';
import { scrub } from './gbrain/cli.ts';

export type AppEnv = { Variables: { user: User | null } };

export const SESSION_COOKIE = 'mobrain_session';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: unknown) { super(code); }
}

export function onError(err: Error, c: Context): Response {
  if (err instanceof HttpError) {
    const body: Record<string, unknown> = { error: err.code };
    if (err.detail !== undefined) body.detail = err.detail;
    return c.json(body, err.status as 400);
  }
  console.error(scrub(String(err.stack ?? err)));
  return c.json({ error: 'internal' }, 500);
}

/** Resolve the caller from the session cookie or a Bearer API key. */
export function authenticate(sql: Sql, now: () => Date): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let user: User | null = null;
    const auth = c.req.header('authorization');
    if (auth?.startsWith('Bearer mbk_')) user = await userForApiKey(sql, auth.slice(7));
    else {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) user = await userForSession(sql, token, now());
    }
    c.set('user', user);
    await next();
  };
}

export function requireUser(c: Context<AppEnv>): User {
  const u = c.get('user');
  if (!u) throw new HttpError(401, 'unauthenticated');
  return u;
}

export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const u = requireUser(c);
    if (!roles.includes(u.role)) throw new HttpError(403, 'forbidden');
    await next();
  };
}

export async function jsonBody<T>(c: Context): Promise<T> {
  try { return (await c.req.json()) as T; } catch { throw new HttpError(400, 'invalid_json'); }
}
