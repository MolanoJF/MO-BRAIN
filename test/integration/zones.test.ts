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

const { insertCommandSchedule } = await import('../helpers/zoneFixture.ts');

describe('schedules are private to their zone', () => {
  let aliceSchedule = '';
  let companySchedule = '';
  let orphanSchedule = '';

  beforeAll(async () => {
    aliceSchedule = await insertCommandSchedule(fx.orgId, fx.alice.privateConnectionId, 'alice-inbox-digest');
    const companyConn = randomUUID();
    await getDb().insert(schema.connections).values({
      id: companyConn, organizationId: fx.orgId, membershipId: fx.admin.membershipId,
      writeSpaceId: fx.companySpaceId, readSpaceIds: [], harness: 'generic',
      clientName: `bs-company-${companyConn.slice(0, 6)}`, profile: 'coding-agent', tokenTtl: 3600, state: 'active',
    });
    companySchedule = await insertCommandSchedule(fx.orgId, companyConn, 'company-sync');
    orphanSchedule = await insertCommandSchedule(fx.orgId, null, 'orphaned-job');
  });

  const names = async (cookie: string) =>
    ((await (await hit('GET', '/api/schedules', cookie)).json()) as { schedules: Array<{ name: string }> })
      .schedules.map((s) => s.name).sort();

  test('each caller lists only their own personal schedules plus company ones', async () => {
    expect(await names(fx.alice.cookie)).toEqual(['alice-inbox-digest', 'company-sync']);
    expect(await names(fx.bob.cookie)).toEqual(['company-sync']);
    expect(await names(fx.owner.cookie)).toEqual(['company-sync', 'orphaned-job']);
  });

  test("an owner gets 404 on a member's personal schedule, its runs, and its actions", async () => {
    expect((await hit('GET', `/api/schedules/${aliceSchedule}`, fx.owner.cookie)).status).toBe(404);
    expect((await hit('GET', `/api/schedules/${aliceSchedule}/runs`, fx.owner.cookie)).status).toBe(404);
    expect((await hit('POST', `/api/schedules/${aliceSchedule}/run-now`, fx.owner.cookie, {})).status).toBe(404);
    expect((await hit('PATCH', `/api/schedules/${aliceSchedule}`, fx.owner.cookie, { enabled: false })).status).toBe(404);
    expect((await hit('DELETE', `/api/schedules/${aliceSchedule}`, fx.owner.cookie)).status).toBe(404);
  });

  test('the owning member still reads their own schedule', async () => {
    expect((await hit('GET', `/api/schedules/${aliceSchedule}`, fx.alice.cookie)).status).toBe(200);
  });

  test("an admin cannot create a schedule on a member's private connection", async () => {
    const res = await hit('POST', '/api/schedules', fx.admin.cookie, {
      name: 'sneaky', connectionId: fx.alice.privateConnectionId, operation: 'sync',
      kind: 'interval', intervalSeconds: 3600,
    });
    expect(res.status).toBe(403);
  });

  test('a sub-hourly 409 does not name a holder outside the caller\'s zone', async () => {
    const hidden = 'alice-live-lane';
    const hiddenId = await insertCommandSchedule(fx.orgId, fx.alice.privateConnectionId, hidden);
    await getDb().update(schema.schedules).set({ intervalSeconds: 300 }).where(eq(schema.schedules.id, hiddenId));

    const refused = async (cookie: string, connectionId: string, name: string) => {
      const res = await hit('POST', '/api/schedules', cookie, {
        name, connectionId, operation: 'sync', kind: 'interval', intervalSeconds: 300,
      });
      expect(res.status).toBe(409);
      return await res.json() as { error: string; holder?: string; detail?: string };
    };

    for (const [cookie, connectionId, name] of [
      [fx.owner.cookie, fx.owner.privateConnectionId, 'owner-live'],
      [fx.admin.cookie, fx.admin.privateConnectionId, 'admin-live'],
      [fx.bob.cookie, fx.bob.privateConnectionId, 'bob-live'],
    ] as const) {
      const body = await refused(cookie, connectionId, name);
      expect(body.error).toBe('sub_hourly_limit');
      expect(body.holder).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(hidden);
    }

    const own = await refused(fx.alice.cookie, fx.alice.privateConnectionId, 'alice-second-lane');
    expect(own.error).toBe('sub_hourly_limit');
    expect(own.holder).toBe(hidden);

    const bobHourly = await insertCommandSchedule(fx.orgId, fx.bob.privateConnectionId, 'bob-hourly');
    const patched = await hit('PATCH', `/api/schedules/${bobHourly}`, fx.bob.cookie, { intervalSeconds: 300 });
    expect(patched.status).toBe(409);
    const patchBody = await patched.json() as { error: string; holder?: string };
    expect(patchBody.error).toBe('sub_hourly_limit');
    expect(patchBody.holder).toBeUndefined();
    expect(JSON.stringify(patchBody)).not.toContain(hidden);

    await getDb().delete(schema.schedules).where(eq(schema.schedules.id, hiddenId));
  });
});

const { insertAgentRun } = await import('../helpers/zoneFixture.ts');

describe('runs and alerts are private to their zone', () => {
  let aliceRun = '';
  let aliceScheduleId = '';

  beforeAll(async () => {
    const r = await insertAgentRun(fx.orgId, fx.alice.privateConnectionId, 'alice-calendar-prep');
    aliceRun = r.runId;
    aliceScheduleId = r.scheduleId;
    await getDb().insert(schema.scheduleAlerts).values({
      id: randomUUID(), organizationId: fx.orgId, scheduleId: aliceScheduleId, kind: 'run_failed',
    });
  });

  test("an owner does not see a member's personal run in the list or by id, and cannot revert it", async () => {
    const list = await (await hit('GET', '/api/runs', fx.owner.cookie)).json() as { runs: Array<{ scheduleName: string }> };
    expect(list.runs.some((r) => r.scheduleName === 'alice-calendar-prep')).toBe(false);
    expect((await hit('GET', `/api/runs/${aliceRun}`, fx.owner.cookie)).status).toBe(404);
    expect((await hit('POST', `/api/runs/${aliceRun}/revert`, fx.owner.cookie, {})).status).toBe(404);
  });

  test('the owning member sees their run', async () => {
    const list = await (await hit('GET', '/api/runs', fx.alice.cookie)).json() as { runs: Array<{ scheduleName: string }> };
    expect(list.runs.some((r) => r.scheduleName === 'alice-calendar-prep')).toBe(true);
    expect((await hit('GET', `/api/runs/${aliceRun}`, fx.alice.cookie)).status).toBe(200);
  });

  test("alerts on a personal schedule are the owner's only", async () => {
    const forBob = await (await hit('GET', '/api/schedule-alerts', fx.bob.cookie)).json() as { alerts: Array<{ scheduleId: string }> };
    expect(forBob.alerts.some((a) => a.scheduleId === aliceScheduleId)).toBe(false);
    const forAlice = await (await hit('GET', '/api/schedule-alerts', fx.alice.cookie)).json() as { alerts: Array<{ scheduleId: string }> };
    expect(forAlice.alerts.some((a) => a.scheduleId === aliceScheduleId)).toBe(true);
  });
});

describe('connections and sources hide other members\' personal rows', () => {
  test("GET /connections omits other members' private connections", async () => {
    const body = await (await hit('GET', '/api/connections', fx.owner.cookie)).json() as { connections: Array<{ id: string }> };
    const ids = body.connections.map((c) => c.id);
    expect(ids).toContain(fx.owner.privateConnectionId);
    expect(ids).not.toContain(fx.alice.privateConnectionId);
  });

  test("an owner cannot revoke a member's private connection", async () => {
    expect((await hit('POST', `/api/connections/${fx.alice.privateConnectionId}/revoke`, fx.owner.cookie, {})).status).toBe(404);
  });

  test('an admin cannot create a connection that touches a personal Space', async () => {
    const res = await hit('POST', '/api/connections', fx.admin.cookie, {
      membershipId: fx.bob.membershipId, writeSpaceId: fx.companySpaceId,
      readSpaceIds: [fx.alice.privateSpaceId], harness: 'generic',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('personal_space_not_grantable');
  });

  test("GET /sources omits other members' private Spaces; PATCH/DELETE on them is unknown", async () => {
    const body = await (await hit('GET', '/api/sources', fx.owner.cookie)).json() as { sources: Array<{ sourceId: string }> };
    const ids = body.sources.map((s) => s.sourceId);
    expect(ids).toContain(fx.owner.privateSourceId);
    expect(ids).not.toContain(fx.alice.privateSourceId);
    expect((await hit('PATCH', `/api/sources/${fx.alice.privateSourceId}`, fx.owner.cookie, { name: 'x' })).status).toBe(400);
    expect((await hit('DELETE', `/api/sources/${fx.alice.privateSourceId}`, fx.owner.cookie, { mode: 'archive' })).status).toBe(400);
  });
});

describe('spend', () => {
  test("the admin Spend page never names a member's personal schedule", async () => {
    const body = await (await hit('GET', '/api/spend?days=30', fx.owner.cookie)).json() as {
      ours: { bySchedule: Array<{ key: string; label: string }>; byMember: Array<{ label: string }> };
    };
    const labels = body.ours.bySchedule.map((r) => r.label);
    expect(labels).not.toContain('alice-calendar-prep');
    expect(labels).toContain('Personal automations (z-alice@example.test)');
    expect(body.ours.byMember.map((r) => r.label)).toContain('z-alice@example.test');
  });
});
