// test/db/people-access.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';
import type { User } from '../../src/server/types.ts';

let w: TestWorld; let people: PeopleService; let owner: User;
beforeAll(async () => {
  w = await world(); people = new PeopleService(w.deps);
  await people.bootstrapOwner({ email: 'own@x.io' });
  owner = await people.userByEmail('own@x.io');
  await people.setMode(owner, 'company');
  await people.addCompanySource(owner, 'Secret');
});
afterAll(async () => w.drop());

const tokenFrom = (url: string) => url.split('/claim/')[1]!;

describe('invite and claim (rule 8)', () => {
  test('an invite makes an invited user with no password and a 24h link', async () => {
    const { claimUrl } = await people.invite(owner, 'Mem@X.io', 'member');
    expect(claimUrl).toStartWith('http://127.0.0.1:8787/claim/');
    const [u] = await w.sql`select status, password_hash from users where email = 'mem@x.io'`;
    expect(u).toMatchObject({ status: 'invited', passwordHash: null });
  });

  test('claim sets the password once, activates, creates the private source and a ui client', async () => {
    const { claimUrl } = await people.invite(owner, 'm2@x.io', 'member');
    const r = await people.claim(tokenFrom(claimUrl), 'a-long-password', 'Mo');
    expect(r.user.status).toBe('active');
    expect(r.joinKey.startsWith('mbk_')).toBe(true);
    const [src] = await w.sql`select id from sources where owner_user_id = ${r.user.id}`;
    expect(src!.id).toBe('p-m2');
    expect(w.admin.live(r.user.id).map((c) => c.purpose)).toEqual(['ui']);
    await expect(people.claim(tokenFrom(claimUrl), 'again-password', null)).rejects.toMatchObject({ code: 'invite_invalid' });
  });

  test('an expired invite is refused', async () => {
    const { claimUrl } = await people.invite(owner, 'late@x.io', 'viewer');
    w.setNow(new Date(w.deps.now().getTime() + 25 * 3600_000));
    await expect(people.claim(tokenFrom(claimUrl), 'a-long-password', null)).rejects.toMatchObject({ code: 'invite_invalid' });
    w.setNow(new Date('2026-10-14T12:00:00Z'));
  });

  test('a short password is refused', async () => {
    const { claimUrl } = await people.invite(owner, 'short@x.io', 'member');
    await expect(people.claim(tokenFrom(claimUrl), 'short', null)).rejects.toMatchObject({ code: 'password_too_short' });
  });
});

describe('grants (rules 5, 6, 7)', () => {
  test('a member reads only granted company sources, never the owner private source', async () => {
    const m = await people.userByEmail('m2@x.io');
    expect(w.admin.live(m.id).find((c) => c.purpose === 'ui')!.readSources).toEqual([]);
    await people.grant(owner, m.id, 'c-company', true);
    const ui = w.admin.live(m.id).find((c) => c.purpose === 'ui')!;
    expect(ui.readSources).toEqual(['c-company']);
    expect(ui.readSources).not.toContain('p-own');
  });

  test('revoking a grant narrows before the DB row goes, and a gbrain failure changes nothing', async () => {
    const m = await people.userByEmail('m2@x.io');
    w.admin.failNext = 'rescopeClient';
    await expect(people.revokeGrant(owner, m.id, 'c-company')).rejects.toThrow();
    const [still] = await w.sql`select 1 from grants where user_id = ${m.id} and source_id = 'c-company'`;
    expect(still).toBeDefined();
    expect(w.admin.live(m.id).find((c) => c.purpose === 'ui')!.readSources).toEqual(['c-company']);
    await people.revokeGrant(owner, m.id, 'c-company');
    expect(w.admin.live(m.id).find((c) => c.purpose === 'ui')!.readSources).toEqual([]);
  });

  test('reconcile narrows before it widens', async () => {
    const m = await people.userByEmail('m2@x.io');
    await people.grant(owner, m.id, 'c-company', true);
    w.admin.calls = [];
    await people.changeAccess([m.id], async (tx) => {
      await tx`delete from grants where user_id = ${m.id} and source_id = 'c-company'`;
      await tx`insert into grants (user_id, source_id) values (${m.id}, 'c-secret')`;
    });
    // The first rescope is the intersection: neither the old nor the new source.
    const ui = w.admin.live(m.id).find((c) => c.purpose === 'ui')!;
    expect(ui.readSources).toEqual(['c-secret']);
    expect(w.admin.calls.filter((c) => c === 'rescopeClient').length).toBeGreaterThanOrEqual(2);
  });

  test('grants on a private source are refused', async () => {
    const m = await people.userByEmail('m2@x.io');
    await expect(people.grant(owner, m.id, 'p-own', true)).rejects.toMatchObject({ code: 'not_a_company_source' });
  });

  test('a member turns agent reads off for one source; only the agent client narrows', async () => {
    const m = await people.userByEmail('m2@x.io');
    await people.setAgentReads(m, 'c-secret', false);
    const live = w.admin.live(m.id);
    expect(live.find((c) => c.purpose === 'ui')!.readSources).toEqual(['c-secret']);
    expect(live.find((c) => c.purpose === 'agent')).toBeUndefined(); // no agent client issued yet
  });
});

describe('roles', () => {
  test('the owner promotes a member to admin; the admin then reads every company source', async () => {
    const m = await people.userByEmail('m2@x.io');
    await people.setRole(owner, m.id, 'admin');
    expect(w.admin.live(m.id).find((c) => c.purpose === 'ui')!.readSources.sort()).toEqual(['c-company', 'c-secret']);
  });

  test('a viewer promoted to member gets a private source', async () => {
    const { claimUrl } = await people.invite(owner, 'v@x.io', 'viewer');
    const { user } = await people.claim(tokenFrom(claimUrl), 'viewer-password', null);
    const [none] = await w.sql`select 1 from sources where owner_user_id = ${user.id}`;
    expect(none).toBeUndefined();
    await people.setRole(owner, user.id, 'member');
    const [src] = await w.sql`select id from sources where owner_user_id = ${user.id}`;
    expect(src!.id).toBe('p-v');
  });
});
