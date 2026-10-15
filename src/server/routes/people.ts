import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Deps } from '../app.ts';
import { createSession } from '../auth.ts';
import { getMode } from '../db/index.ts';
import { HttpError, jsonBody, requireRole, requireUser, SESSION_COOKIE, type AppEnv } from '../http.ts';
import { PeopleService } from '../people/service.ts';
import type { Role } from '../types.ts';

const ROLES: Role[] = ['admin', 'member', 'viewer'];

export function peopleRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const people = new PeopleService(deps);
  const managers = requireRole('owner', 'admin');

  r.get('/api/people', managers, async (c) => {
    const users = await deps.sql`select id, email, name, role, status, created_at from users order by created_at`;
    const grants = await deps.sql<{ userId: string; sourceId: string; agentReads: boolean }[]>`select user_id, source_id, agent_reads from grants`;
    const sources = await deps.sql`select id, kind, owner_user_id, name, status from sources order by kind, id`;
    return c.json({
      mode: await getMode(deps.sql),
      users: users.map((u) => ({ ...u, grants: grants.filter((g) => g.userId === u.id).map(({ sourceId, agentReads }) => ({ sourceId, agentReads })) })),
      sources,
    });
  });

  r.post('/api/people/mode', requireRole('owner'), async (c) => {
    const { mode } = await jsonBody<{ mode?: string }>(c);
    if (mode !== 'company' && mode !== 'personal') throw new HttpError(400, 'invalid_mode');
    await people.setMode(requireUser(c), mode);
    return c.json({ ok: true, mode });
  });

  r.post('/api/people/invite', managers, async (c) => {
    const { email, role } = await jsonBody<{ email?: string; role?: Role }>(c);
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, 'invalid_email');
    if (!role || !ROLES.includes(role)) throw new HttpError(400, 'invalid_role');
    return c.json(await people.invite(requireUser(c), email, role));
  });

  r.post('/api/people/:id/role', managers, async (c) => {
    const { role } = await jsonBody<{ role?: Role }>(c);
    if (!role || !ROLES.includes(role)) throw new HttpError(400, 'invalid_role');
    await people.setRole(requireUser(c), c.req.param('id'), role);
    return c.json({ ok: true });
  });

  r.post('/api/people/:id/offboard', managers, async (c) => {
    await people.offboard(requireUser(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  r.put('/api/people/:id/grants/:sourceId', managers, async (c) => {
    const { agentReads } = await jsonBody<{ agentReads?: boolean }>(c);
    await people.grant(requireUser(c), c.req.param('id'), c.req.param('sourceId'), agentReads !== false);
    return c.json({ ok: true });
  });

  r.delete('/api/people/:id/grants/:sourceId', managers, async (c) => {
    await people.revokeGrant(requireUser(c), c.req.param('id'), c.req.param('sourceId'));
    return c.json({ ok: true });
  });

  r.post('/api/sources/company', managers, async (c) => {
    const { name } = await jsonBody<{ name?: string }>(c);
    if (!name?.trim()) throw new HttpError(400, 'name_required');
    return c.json({ id: await people.addCompanySource(requireUser(c), name.trim()) });
  });

  r.post('/api/sources/:id/archive', managers, async (c) => {
    await people.archiveCompanySource(requireUser(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  r.patch('/api/me/grants/:sourceId', async (c) => {
    const { agentReads } = await jsonBody<{ agentReads?: boolean }>(c);
    if (typeof agentReads !== 'boolean') throw new HttpError(400, 'agentReads_required');
    await people.setAgentReads(requireUser(c), c.req.param('sourceId'), agentReads);
    return c.json({ ok: true });
  });

  r.get('/api/claim/:token', async (c) => c.json(await people.inviteInfo(c.req.param('token'))));

  r.post('/api/claim/:token', async (c) => {
    const { password, name } = await jsonBody<{ password?: string; name?: string }>(c);
    if (!password) throw new HttpError(400, 'password_required');
    const result = await people.claim(c.req.param('token'), password, name ?? null);
    const session = await createSession(deps.sql, result.user.id, deps.now());
    setCookie(c, SESSION_COOKIE, session, { httpOnly: true, sameSite: 'Lax', secure: deps.env.secureCookies, path: '/', maxAge: 30 * 86400 });
    return c.json(result);
  });

  r.post('/api/clients/issue', async (c) => {
    const user = requireUser(c);
    const { purpose, sourceId } = await jsonBody<{ purpose?: string; sourceId?: string }>(c);
    if (purpose === 'agent') return c.json(await people.issueAgent(user));
    if (purpose === 'company_writer' && sourceId) return c.json(await people.issueCompanyWriter(user, sourceId));
    throw new HttpError(400, 'invalid_purpose');
  });

  r.get('/api/clients/me', async (c) => c.json({ clients: await people.myClients(requireUser(c)) }));

  return r;
}
