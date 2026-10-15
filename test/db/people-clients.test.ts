// test/db/people-clients.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
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

test('issueAgent returns the token once, stores only the expiry, and rotates the previous agent client', async () => {
  const a = await people.issueAgent(owner);
  expect(a.token.startsWith('tok-')).toBe(true);
  expect(a.mcpUrl).toBe('http://127.0.0.1:8787/mcp');
  const [row] = await w.sql`select token_enc, expires_at from gbrain_clients where purpose = 'agent' and revoked_at is null`;
  expect(row!.tokenEnc).toBeNull();
  expect(row!.expiresAt).toBeInstanceOf(Date);
  const b = await people.issueAgent(owner);
  expect(b.token).not.toBe(a.token);
  expect((await w.sql`select count(*)::int as n from gbrain_clients where purpose = 'agent' and revoked_at is null`)[0]!.n).toBe(1);
});

test('myClients lists purpose and expiry, never tokens', async () => {
  const list = await people.myClients(owner);
  expect(list.map((c) => c.purpose).sort()).toEqual(['agent', 'ui']);
  expect(JSON.stringify(list)).not.toContain('tok-');
});

test('a company writer needs company mode and an admin', async () => {
  await expect(people.issueCompanyWriter(owner, 'c-company')).rejects.toMatchObject({ code: 'company_mode_required' });
  await people.setMode(owner, 'company');
  const cw = await people.issueCompanyWriter(owner, 'c-company');
  expect(w.admin.live(owner.id).find((s) => s.purpose === 'company_writer')!.writeSource).toBe('c-company');
  expect(cw.registrationName).toBe('gbrain-company-c-company');
});
