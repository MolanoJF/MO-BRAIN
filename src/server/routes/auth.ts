import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createSession, deleteSession, LoginThrottle, loginWithPassword } from '../auth.ts';
import { getMode } from '../db/index.ts';
import { HttpError, jsonBody, requireUser, SESSION_COOKIE, type AppEnv } from '../http.ts';
import type { Deps } from '../app.ts';

export function authRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const throttle = new LoginThrottle();

  r.post('/api/auth/login', async (c) => {
    const { email, password } = await jsonBody<{ email?: string; password?: string }>(c);
    if (!email || !password) throw new HttpError(400, 'email_and_password_required');
    const now = deps.now();
    if (throttle.locked(email, now.getTime())) throw new HttpError(429, 'too_many_attempts');
    const user = await loginWithPassword(deps.sql, email, password);
    if (!user) { throttle.fail(email, now.getTime()); throw new HttpError(401, 'invalid_credentials'); }
    throttle.clear(email);
    const token = await createSession(deps.sql, user.id, now);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'Lax', secure: deps.env.secureCookies, path: '/', maxAge: 30 * 86400,
    });
    return c.json({ user });
  });

  r.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteSession(deps.sql, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  r.get('/api/me', async (c) => {
    const user = requireUser(c);
    const grants = await deps.sql<{ sourceId: string; name: string; agentReads: boolean }[]>`
      select g.source_id, s.name, g.agent_reads from grants g join sources s on s.id = g.source_id
      where g.user_id = ${user.id} and s.status = 'active' order by s.name`;
    return c.json({ user, mode: await getMode(deps.sql), grants, publicUrl: deps.env.publicUrl });
  });

  return r;
}
