// test/db/people-mode.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';
import type { User } from '../../src/server/types.ts';

let w: TestWorld; let people: PeopleService; let owner: User;
beforeAll(async () => {
  w = await world(); people = new PeopleService(w.deps);
  await people.bootstrapOwner({ email: 'own@x.io' });
  owner = await people.userByEmail('own@x.io');
});
afterAll(async () => w.drop());

describe('mode', () => {
  test('a fresh install is personal and refuses company operations (rules 1, 4)', async () => {
    await expect(people.addCompanySource(owner, 'Eng')).rejects.toMatchObject({ code: 'company_mode_required' });
    await expect(people.invite(owner, 'm@x.io', 'member')).rejects.toMatchObject({ code: 'company_mode_required' });
  });

  test('switching to company creates c-company and widens the owner to read it', async () => {
    await people.setMode(owner, 'company');
    const [s] = await w.sql`select id, kind from sources where kind = 'company'`;
    expect(s).toMatchObject({ id: 'c-company' });
    const ui = w.admin.live(owner.id).find((c) => c.purpose === 'ui')!;
    expect(ui.readSources).toEqual(['c-company']);
  });

  test('a second company source gets its own id and every admin reads it', async () => {
    const id = await people.addCompanySource(owner, 'Engineering & Ops');
    expect(id).toBe('c-engineering-ops');
    expect(w.admin.live(owner.id).find((c) => c.purpose === 'ui')!.readSources).toEqual(['c-company', 'c-engineering-ops']);
  });

  test('switching back is refused while anyone else is not disabled (rule 3)', async () => {
    await people.invite(owner, 'm@x.io', 'member');
    await expect(people.setMode(owner, 'personal')).rejects.toMatchObject({ code: 'not_sole_member' });
  });

  test('archiving a company source narrows clients and archives it in gbrain', async () => {
    await people.archiveCompanySource(owner, 'c-engineering-ops');
    expect(w.admin.live(owner.id).find((c) => c.purpose === 'ui')!.readSources).toEqual(['c-company']);
    expect(w.admin.sources.get('c-engineering-ops')!.archived).toBe(true);
  });
});
