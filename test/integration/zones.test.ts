// test/integration/zones.test.ts
import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { installOpsMock } from '../helpers/opsMock.ts';

const ops = installOpsMock();

const { getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { sql, and, eq } = await import('drizzle-orm');
const { buildZoneFixture, hit } = await import('../helpers/zoneFixture.ts');
type ZoneFixture = Awaited<ReturnType<typeof buildZoneFixture>>;

pinDb();
let fx: ZoneFixture;

beforeAll(async () => { fx = await buildZoneFixture(); }, 120_000);
beforeEach(() => ops.reset());
afterAll(async () => { await closeDb(); });

describe('grants — the migration backfill', () => {
  test('a live connection becomes a grant on company Spaces only; write beats read', async () => {
    const readOnlyId = randomUUID();
    await getDb().insert(schema.spaces).values({
      id: readOnlyId, organizationId: fx.orgId, sourceId: 'company-ro', name: 'RO',
      kind: 'local-git', localPath: '/srv/brain-repos/company-ro', ownerMembershipId: null,
    });
    await getDb().insert(schema.connections).values({
      id: randomUUID(), organizationId: fx.orgId, membershipId: fx.bob.membershipId,
      writeSpaceId: fx.companySpaceId, readSpaceIds: [readOnlyId, fx.alice.privateSpaceId],
      harness: 'generic', clientName: `bs-backfill-${randomUUID().slice(0, 6)}`,
      profile: 'memory-writer', tokenTtl: 3600, state: 'active',
    });

    const migration = readFileSync('src/control/db/migrations/0011_space_grants.sql', 'utf8');
    const backfill = migration.split('--> statement-breakpoint').find((s) => s.includes('INSERT INTO "space_grants"'))!;
    await getDb().execute(sql.raw(backfill));

    const rows = await getDb().select().from(schema.spaceGrants)
      .where(eq(schema.spaceGrants.membershipId, fx.bob.membershipId));
    const byspace = Object.fromEntries(rows.map((r) => [r.spaceId, r.access]));
    expect(byspace[fx.companySpaceId]).toBe('write');
    expect(byspace[readOnlyId]).toBe('read');
    expect(byspace[fx.alice.privateSpaceId]).toBeUndefined(); // personal Spaces are never granted

    await getDb().delete(schema.spaceGrants).where(eq(schema.spaceGrants.membershipId, fx.bob.membershipId));
    await getDb().delete(schema.connections).where(and(
      eq(schema.connections.membershipId, fx.bob.membershipId),
      eq(schema.connections.writeSpaceId, fx.companySpaceId),
    ));
    await getDb().delete(schema.spaces).where(eq(schema.spaces.id, readOnlyId));
  });
});

describe('Files — access comes from grants', () => {
  test('a member without a grant cannot see the company Space; with a read grant they can', async () => {
    const before = await (await hit('GET', '/api/spaces', fx.alice.cookie)).json() as { spaces: Array<{ id: string; access: string }> };
    expect(before.spaces.map((s) => s.id)).toEqual([fx.alice.privateSpaceId]);

    await getDb().insert(schema.spaceGrants).values({
      organizationId: fx.orgId, membershipId: fx.alice.membershipId, spaceId: fx.companySpaceId,
      access: 'read', grantedBy: 'test',
    });
    const after = await (await hit('GET', '/api/spaces', fx.alice.cookie)).json() as { spaces: Array<{ id: string; access: string }> };
    const company = after.spaces.find((s) => s.id === fx.companySpaceId);
    expect(company?.access).toBe('read');
    expect(after.spaces.some((s) => s.id === fx.bob.privateSpaceId)).toBe(false);

    await getDb().delete(schema.spaceGrants).where(eq(schema.spaceGrants.membershipId, fx.alice.membershipId));
  });

  test("an owner still cannot open a member's private Space", async () => {
    const res = await hit('GET', `/api/spaces/${fx.alice.privateSourceId}/files`, fx.owner.cookie);
    expect(res.status).toBe(403);
  });
});

describe('admin grants API', () => {
  test('PUT then GET a grant; members cannot call it', async () => {
    const put = await hit('PUT', '/api/grants', fx.admin.cookie, {
      membershipId: fx.alice.membershipId, spaceId: fx.companySpaceId, access: 'read',
    });
    expect(put.status).toBe(200);

    const list = await (await hit('GET', '/api/grants', fx.admin.cookie)).json() as { grants: Array<{ membershipId: string; spaceId: string; access: string }> };
    expect(list.grants).toContainEqual({ membershipId: fx.alice.membershipId, spaceId: fx.companySpaceId, access: 'read' });

    expect((await hit('GET', '/api/grants', fx.alice.cookie)).status).toBe(403);
    expect((await hit('PUT', '/api/grants', fx.alice.cookie, {
      membershipId: fx.alice.membershipId, spaceId: fx.companySpaceId, access: 'write',
    })).status).toBe(403);
  });

  test('a personal Space cannot be granted', async () => {
    const res = await hit('PUT', '/api/grants', fx.admin.cookie, {
      membershipId: fx.bob.membershipId, spaceId: fx.alice.privateSpaceId, access: 'read',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('personal_space_not_grantable');
  });

  test("DELETE rescopes the member's private connection instead of revoking it", async () => {
    await getDb().update(schema.connections)
      .set({ readSpaceIds: [fx.companySpaceId] })
      .where(eq(schema.connections.id, fx.alice.privateConnectionId));

    const res = await hit('DELETE', '/api/grants', fx.admin.cookie, {
      membershipId: fx.alice.membershipId, spaceId: fx.companySpaceId,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { removed: boolean; revoked: string[]; rescoped: string[] };
    expect(body.removed).toBe(true);
    expect(body.rescoped).toEqual([fx.alice.privateConnectionId]);
    expect(body.revoked).toEqual([]);

    const [conn] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, fx.alice.privateConnectionId));
    expect(conn?.state).toBe('active');
    expect(conn?.readSpaceIds).toEqual([]);
    expect(ops.calls.some((c) => c.op === 'auth.rescopeClient')).toBe(true);
  });
});
