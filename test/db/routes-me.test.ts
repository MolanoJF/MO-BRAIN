import { afterAll, beforeAll, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';
import { createSession } from '../../src/server/auth.ts';

let w: TestWorld; let session: string; let memberId: string;
beforeAll(async () => {
  w = await world();
  const people = new PeopleService(w.deps);
  await people.bootstrapOwner({ email: 'own@x.io' });
  const owner = await people.userByEmail('own@x.io');
  await people.setMode(owner, 'company');
  const { claimUrl } = await people.invite(owner, 'm@x.io', 'member');
  const { user } = await people.claim(claimUrl.split('/claim/')[1]!, 'member-password', null);
  memberId = user.id;
  await people.grant(owner, user.id, 'c-company', false);
  session = await createSession(w.sql, user.id, w.deps.now());
});
afterAll(async () => w.drop());

test('/api/me includes my grants and the public url', async () => {
  const me = await (await w.req('/api/me', { as: session })).json();
  expect(me.grants).toEqual([{ sourceId: 'c-company', name: 'Company', agentReads: false }]);
  expect(me.publicUrl).toBe('http://127.0.0.1:8787');
});

test('a new join key replaces the previous ones and comes with the command to paste', async () => {
  const a = await (await w.req('/api/me/join-key', { method: 'POST', as: session })).json();
  const b = await (await w.req('/api/me/join-key', { method: 'POST', as: session })).json();
  expect(a.key).not.toBe(b.key);
  expect(b.command).toContain(`mobrain join --url http://127.0.0.1:8787 --key ${b.key}`);
  expect((await w.req('/api/me', { as: a.key })).status).toBe(401);
  const live = await w.sql`select count(*)::int as n from api_keys where user_id = ${memberId} and label = 'join' and revoked_at is null`;
  expect(live[0]!.n).toBe(1);
});
