// test/db/routes-people.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';

let w: TestWorld; let ownerKey: string; let memberKey: string; let memberId: string;
beforeAll(async () => {
  w = await world();
  const people = new PeopleService(w.deps);
  ({ apiKey: ownerKey } = await people.bootstrapOwner({ email: 'own@x.io' }));
});
afterAll(async () => w.drop());

const post = (path: string, body: unknown, as?: string) => w.req(path, { method: 'POST', body: JSON.stringify(body), as });

describe('people routes', () => {
  test('mode switch is owner only and turns on company mode', async () => {
    expect((await post('/api/people/mode', { mode: 'company' })).status).toBe(401);
    expect((await post('/api/people/mode', { mode: 'company' }, ownerKey)).status).toBe(200);
  });

  test('invite returns a claim URL; claim info and claim are public', async () => {
    const r = await (await post('/api/people/invite', { email: 'm@x.io', role: 'member' }, ownerKey)).json();
    const token = r.claimUrl.split('/claim/')[1];
    expect(await (await w.req(`/api/claim/${token}`)).json()).toEqual({ email: 'm@x.io', role: 'member' });
    const c = await post(`/api/claim/${token}`, { password: 'member-password', name: 'M' });
    expect(c.status).toBe(200);
    expect(c.headers.get('set-cookie')).toContain('mobrain_session=');
    const body = await c.json();
    memberKey = body.joinKey; memberId = body.user.id;
  });

  test('members cannot list or manage people', async () => {
    expect((await w.req('/api/people', { as: memberKey })).status).toBe(403);
    expect((await post('/api/people/invite', { email: 'z@x.io', role: 'member' }, memberKey)).status).toBe(403);
  });

  test('owner lists people with grants and sources', async () => {
    await w.req(`/api/people/${memberId}/grants/c-company`, { method: 'PUT', body: JSON.stringify({ agentReads: true }), as: ownerKey });
    const r = await (await w.req('/api/people', { as: ownerKey })).json();
    expect(r.mode).toBe('company');
    const m = r.users.find((u: { id: string }) => u.id === memberId);
    expect(m.grants).toEqual([{ sourceId: 'c-company', agentReads: true }]);
    expect(r.sources.map((s: { id: string }) => s.id)).toContain('c-company');
    expect(JSON.stringify(r)).not.toContain('passwordHash');
  });

  test('a member issues their own agent client and sees it listed', async () => {
    const r = await (await post('/api/clients/issue', { purpose: 'agent' }, memberKey)).json();
    expect(r.token.startsWith('tok-')).toBe(true);
    const list = await (await w.req('/api/clients/me', { as: memberKey })).json();
    expect(list.clients.map((c: { purpose: string }) => c.purpose).sort()).toEqual(['agent', 'ui']);
  });

  test('a member flips agent reads on their own grant', async () => {
    const r = await w.req('/api/me/grants/c-company', { method: 'PATCH', body: JSON.stringify({ agentReads: false }), as: memberKey });
    expect(r.status).toBe(200);
  });

  test('offboard via route', async () => {
    expect((await post(`/api/people/${memberId}/offboard`, {}, ownerKey)).status).toBe(200);
    expect((await w.req('/api/me', { as: memberKey })).status).toBe(401);
  });

  test('every mutation was audited', async () => {
    const actions = (await w.sql`select action from audit_log order by id`).map((r) => r.action);
    for (const a of ['bootstrap', 'mode.set', 'member.invite', 'member.claim', 'grant.add', 'client.issue', 'grant.agent_reads', 'member.offboard.done']) {
      expect(actions).toContain(a);
    }
  });
});
