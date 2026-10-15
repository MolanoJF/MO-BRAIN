// test/db/people-bootstrap.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';

let w: TestWorld; let people: PeopleService;
beforeAll(async () => { w = await world(); people = new PeopleService(w.deps); });
afterAll(async () => w.drop());

describe('bootstrapOwner', () => {
  test('creates the owner, a private source, ui and instance clients, and an API key', async () => {
    const r = await people.bootstrapOwner({ email: 'Ada.L@x.io', name: 'Ada' });
    expect(r.password.length).toBeGreaterThanOrEqual(16);
    expect(r.apiKey.startsWith('mbk_')).toBe(true);
    const [src] = await w.sql`select id, kind from sources`;
    expect(src).toMatchObject({ id: 'p-ada-l', kind: 'private' });
    expect(w.admin.sources.get('p-ada-l')).toBeDefined();
    const clients = await w.sql`select purpose, token_enc from gbrain_clients where revoked_at is null order by purpose`;
    expect(clients.map((c) => c.purpose)).toEqual(['instance', 'ui']);
    expect(clients.every((c) => typeof c.tokenEnc === 'string' && c.tokenEnc.startsWith('v1:'))).toBe(true);
  });

  test('refuses a second bootstrap', async () => {
    await expect(people.bootstrapOwner({ email: 'b@x.io' })).rejects.toMatchObject({ code: 'already_bootstrapped' });
  });
});

describe('tokens', () => {
  test('uiToken and instanceToken open the stored tokens', async () => {
    const owner = await people.userByEmail('ada.l@x.io');
    expect((await people.uiToken(owner)).startsWith('tok-')).toBe(true);
    expect((await people.instanceToken()).startsWith('tok-')).toBe(true);
  });

  test('a ui token within 7 days of expiry is rotated and the old client revoked', async () => {
    const owner = await people.userByEmail('ada.l@x.io');
    const before = await people.uiToken(owner);
    await w.sql`update gbrain_clients set expires_at = ${new Date(w.deps.now().getTime() + 3 * 86400_000)} where purpose = 'ui'`;
    const after = await people.uiToken(owner);
    expect(after).not.toBe(before);
    const live = await w.sql`select count(*)::int as n from gbrain_clients where purpose = 'ui' and revoked_at is null`;
    expect(live[0]!.n).toBe(1);
  });
});
