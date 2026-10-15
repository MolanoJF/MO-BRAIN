// test/db/people-offboard.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';
import type { User } from '../../src/server/types.ts';
import { createSession } from '../../src/server/auth.ts';

let w: TestWorld; let people: PeopleService; let owner: User; let m: User;
beforeAll(async () => {
  w = await world(); people = new PeopleService(w.deps);
  await people.bootstrapOwner({ email: 'own@x.io' });
  owner = await people.userByEmail('own@x.io');
  await people.setMode(owner, 'company');
  const { claimUrl } = await people.invite(owner, 'm@x.io', 'member');
  ({ user: m } = await people.claim(claimUrl.split('/claim/')[1]!, 'member-password', null));
  await people.grant(owner, m.id, 'c-company', true);
  await people.issueAgent(m);
  await createSession(w.sql, m.id, w.deps.now());
});
afterAll(async () => w.drop());

test('offboarding is resumable after a failure and ends fully disabled (rule 9)', async () => {
  w.admin.failNext = 'archiveSource';
  await expect(people.offboard(owner, m.id)).rejects.toThrow();
  const [mid] = await w.sql`select status from users where id = ${m.id}`;
  expect(mid!.status).toBe('offboarding');
  expect(w.admin.live(m.id)).toEqual([]);            // clients were revoked before the failure

  await people.offboard(owner, m.id);                 // second run finishes
  const [u] = await w.sql`select status from users where id = ${m.id}`;
  expect(u!.status).toBe('disabled');
  expect(w.admin.sources.get('p-m')!.archived).toBe(true);
  expect((await w.sql`select count(*)::int as n from grants where user_id = ${m.id}`)[0]!.n).toBe(0);
  expect((await w.sql`select count(*)::int as n from sessions where user_id = ${m.id}`)[0]!.n).toBe(0);
  expect((await w.sql`select count(*)::int as n from api_keys where user_id = ${m.id} and revoked_at is null`)[0]!.n).toBe(0);
});

test('offboarding the owner is refused', async () => {
  await expect(people.offboard(owner, owner.id)).rejects.toMatchObject({ code: 'owner_is_fixed' });
});

test('after offboarding, switching back to personal is allowed', async () => {
  await people.setMode(owner, 'personal');
});
