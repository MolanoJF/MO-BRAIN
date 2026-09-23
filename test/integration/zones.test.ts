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
