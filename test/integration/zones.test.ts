// test/integration/zones.test.ts
import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { installOpsMock } from '../helpers/opsMock.ts';

const ops = installOpsMock();

const { getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { sql, and, eq } = await import('drizzle-orm');
const { buildZoneFixture, hit } = await import('../helpers/zoneFixture.ts');
const { memberClientSecretName, grantCredentialsOutPath } = await import('../../src/control/connections.ts');
const { storeSecret, readSecret } = await import('../../src/control/secrets.ts');
const { wiringSnippet } = await import('../../src/control/harness.ts');
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

describe('my connection — self-service read scope', () => {
  test('a member without a grant has nothing readable; with one they can add it', async () => {
    const before = await (await hit('GET', '/api/my/connection', fx.bob.cookie)).json() as {
      space: { id: string }; connection: { id: string; readSpaceIds: string[] } | null; readable: Array<{ id: string }>;
    };
    expect(before.space.id).toBe(fx.bob.privateSpaceId);
    expect(before.connection?.id).toBe(fx.bob.privateConnectionId);
    expect(before.readable).toEqual([]);

    const refused = await hit('PUT', '/api/my/connection', fx.bob.cookie, { readSpaceIds: [fx.companySpaceId] });
    expect(refused.status).toBe(400);
    expect((await refused.json() as { error: string }).error).toBe('space_not_readable');

    await hit('PUT', '/api/grants', fx.admin.cookie, {
      membershipId: fx.bob.membershipId, spaceId: fx.companySpaceId, access: 'read',
    });
    const ok = await hit('PUT', '/api/my/connection', fx.bob.cookie, { readSpaceIds: [fx.companySpaceId] });
    expect(ok.status).toBe(200);

    const [conn] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, fx.bob.privateConnectionId));
    expect(conn?.readSpaceIds).toEqual([fx.companySpaceId]);
  });

  test("another member's private Space is never readable", async () => {
    const res = await hit('PUT', '/api/my/connection', fx.bob.cookie, { readSpaceIds: [fx.alice.privateSpaceId] });
    expect(res.status).toBe(400);
  });
});

describe('my mcp config', () => {
  const bobHandoff = {
    version: 1,
    mcp_url: 'https://bob.example.test/mcp',
    client_id: 'gbrain_cl_bob_owned',
    client_secret: 'bob-member-secret-do-not-leak-0123456789',
  };
  const aliceHandoff = {
    version: 1,
    mcp_url: 'https://alice.example.test/mcp',
    client_id: 'gbrain_cl_alice_owned',
    client_secret: 'alice-member-secret-do-not-leak-9876543210',
  };

  async function putHandoff(connectionId: string, handoff: object) {
    await storeSecret(fx.orgId, memberClientSecretName(connectionId), JSON.stringify(handoff));
  }

  async function clearHandoff(connectionId: string) {
    await getDb().delete(schema.secrets).where(and(
      eq(schema.secrets.organizationId, fx.orgId),
      eq(schema.secrets.name, memberClientSecretName(connectionId)),
    ));
  }

  type McpBody = {
    mcp_url: string;
    harness: string;
    credentials: { client_id: string; client_secret: string; mcp_url: string };
    snippet: string;
  };

  test('the caller gets their own url, client id, secret, and snippet', async () => {
    await putHandoff(fx.bob.privateConnectionId, bobHandoff);
    ops.setTake(async () => { throw new Error('ENOENT: no such file or directory'); });

    const res = await hit('GET', '/api/my/mcp', fx.bob.cookie);
    expect(res.status).toBe(200);
    const body = await res.json() as McpBody;
    expect(body.mcp_url).toBe(bobHandoff.mcp_url);
    expect(body.harness).toBe('generic');
    expect(body.credentials).toEqual(bobHandoff);
    expect(body.snippet).toBe(wiringSnippet('generic', {
      client_id: bobHandoff.client_id,
      mcp_url: bobHandoff.mcp_url,
    }, { skills: false }));
    expect(ops.calls.some((c) => c.op === 'config.get' && c.params?.key === 'mcp.publish_skills')).toBe(true);
    expect(ops.journalDeletes).toEqual([]);
  });

  test("another member's secret is not in the body", async () => {
    await putHandoff(fx.bob.privateConnectionId, bobHandoff);
    await putHandoff(fx.alice.privateConnectionId, aliceHandoff);
    ops.setTake(async () => { throw new Error('ENOENT: no such file or directory'); });

    const asBob = await hit('GET', '/api/my/mcp', fx.bob.cookie);
    expect(asBob.status).toBe(200);
    const bobBody = JSON.stringify(await asBob.json());
    expect(bobBody).toContain(bobHandoff.client_id);
    expect(bobBody).toContain(bobHandoff.client_secret);
    expect(bobBody).not.toContain(aliceHandoff.client_id);
    expect(bobBody).not.toContain(aliceHandoff.client_secret);

    const asAlice = await hit('GET', '/api/my/mcp', fx.alice.cookie);
    expect(asAlice.status).toBe(200);
    const aliceBody = JSON.stringify(await asAlice.json());
    expect(aliceBody).toContain(aliceHandoff.client_secret);
    expect(aliceBody).not.toContain(bobHandoff.client_secret);
  });

  test('a non-generic harness still gets that harness snippet', async () => {
    await putHandoff(fx.bob.privateConnectionId, bobHandoff);
    const [before] = await getDb().select({ harness: schema.connections.harness })
      .from(schema.connections).where(eq(schema.connections.id, fx.bob.privateConnectionId));
    await getDb().update(schema.connections).set({ harness: 'claude-code' })
      .where(eq(schema.connections.id, fx.bob.privateConnectionId));
    try {
      ops.setCallDecorator((op, result) => (
        op === 'config.get' ? { ...result, ok: true, stdout: 'true\n' } : result
      ));
      const res = await hit('GET', '/api/my/mcp', fx.bob.cookie);
      expect(res.status).toBe(200);
      const body = await res.json() as McpBody;
      expect(body.harness).toBe('claude-code');
      expect(body.credentials.client_secret).toBe(bobHandoff.client_secret);
      expect(body.snippet).toBe(wiringSnippet('claude-code', {
        client_id: bobHandoff.client_id,
        mcp_url: bobHandoff.mcp_url,
      }, { skills: true }));
    } finally {
      await getDb().update(schema.connections).set({ harness: before!.harness })
        .where(eq(schema.connections.id, fx.bob.privateConnectionId));
    }
  });

  test('pending returns connection_pending and does not take or show the stored secret', async () => {
    await putHandoff(fx.bob.privateConnectionId, bobHandoff);
    let took = false;
    ops.setTake(async () => { took = true; throw new Error('ENOENT: no such file or directory'); });
    await getDb().update(schema.connections).set({ state: 'pending' })
      .where(eq(schema.connections.id, fx.bob.privateConnectionId));
    try {
      const res = await hit('GET', '/api/my/mcp', fx.bob.cookie);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'connection_pending' });
      expect(took).toBe(false);
      expect(ops.journalDeletes).toEqual([]);
      expect(ops.calls.some((c) => c.op === 'auth.revokeClient')).toBe(false);
    } finally {
      await getDb().update(schema.connections).set({ state: 'active' })
        .where(eq(schema.connections.id, fx.bob.privateConnectionId));
    }
  });

  test('no private space does not invent a url', async () => {
    await getDb().update(schema.spaces).set({ ownerMembershipId: null })
      .where(eq(schema.spaces.id, fx.admin.privateSpaceId));
    try {
      const res = await hit('GET', '/api/my/mcp', fx.admin.cookie);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'no_private_space' });
    } finally {
      await getDb().update(schema.spaces).set({ ownerMembershipId: fx.admin.membershipId })
        .where(eq(schema.spaces.id, fx.admin.privateSpaceId));
    }
  });

  test('space with no live connection is no_private_connection', async () => {
    const [before] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, fx.admin.privateConnectionId));
    await getDb().update(schema.connections).set({ state: 'revoked' })
      .where(eq(schema.connections.id, fx.admin.privateConnectionId));
    try {
      const res = await hit('GET', '/api/my/mcp', fx.admin.cookie);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'no_private_connection' });
      expect(ops.calls.some((c) => c.op === 'auth.revokeClient' || c.op === 'mcp.grant')).toBe(false);
    } finally {
      await getDb().update(schema.connections).set({
        state: 'active', clientName: before!.clientName, revokedAt: null,
      }).where(eq(schema.connections.id, fx.admin.privateConnectionId));
    }
  });

  test('a missing file and no stored secret is credentials_unavailable and does not revoke', async () => {
    await clearHandoff(fx.bob.privateConnectionId);
    const seen: string[] = [];
    ops.setTake(async (path: string) => {
      seen.push(path);
      throw new Error('ENOENT: no such file or directory');
    });
    const res = await hit('GET', '/api/my/mcp', fx.bob.cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'credentials_unavailable' });
    expect(seen).toEqual([grantCredentialsOutPath(fx.bob.privateConnectionId)]);
    expect(ops.journalDeletes).toEqual([]);
    expect(ops.calls.some((c) => c.op === 'auth.revokeClient' || c.op === 'mcp.grant')).toBe(false);
    const [conn] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, fx.bob.privateConnectionId));
    expect(conn?.state).toBe('active');
    expect(conn?.revokedAt).toBeNull();
    expect(await readSecret(fx.orgId, memberClientSecretName(fx.bob.privateConnectionId))).toBeNull();
  });

  test('a missing secret is taken once, stored, and the journal for that client is deleted', async () => {
    await clearHandoff(fx.bob.privateConnectionId);
    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, fx.bob.privateConnectionId));
    expect(row?.gbrainClientId).toBeTruthy();
    const handoff = {
      version: 1,
      mcp_url: 'https://taken.example.test/mcp',
      client_id: 'gbrain_cl_taken_once',
      client_secret: 'taken-once-secret-abcdefghijklmnop',
    };
    const seen: string[] = [];
    ops.setTake(async (path: string) => {
      seen.push(path);
      return handoff;
    });

    const res = await hit('GET', '/api/my/mcp', fx.bob.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      mcp_url: handoff.mcp_url,
      harness: 'generic',
      credentials: handoff,
    });
    expect(seen).toEqual([grantCredentialsOutPath(fx.bob.privateConnectionId)]);
    expect(ops.journalDeletes).toEqual([row!.gbrainClientId]);
    expect(JSON.parse(await readSecret(fx.orgId, memberClientSecretName(fx.bob.privateConnectionId)) ?? 'null'))
      .toEqual(handoff);
    expect((await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, fx.bob.privateConnectionId)))[0]?.state).toBe('active');

    ops.setTake(async () => { seen.push('second'); throw new Error('ENOENT: no such file or directory'); });
    const again = await hit('GET', '/api/my/mcp', fx.bob.cookie);
    expect(again.status).toBe(200);
    expect((await again.json() as McpBody).credentials).toEqual(handoff);
    expect(seen).toEqual([grantCredentialsOutPath(fx.bob.privateConnectionId)]);
  });

  test('reissue without a live connection is no_private_connection', async () => {
    const [before] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, fx.admin.privateConnectionId));
    await getDb().update(schema.connections).set({ state: 'revoked' })
      .where(eq(schema.connections.id, fx.admin.privateConnectionId));
    try {
      const res = await hit('POST', '/api/my/mcp/reissue', fx.admin.cookie);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'no_private_connection' });
      expect(ops.calls.some((c) => c.op === 'auth.revokeClient' || c.op === 'mcp.grant')).toBe(false);
    } finally {
      await getDb().update(schema.connections).set({
        state: 'active', clientName: before!.clientName, revokedAt: null,
      }).where(eq(schema.connections.id, fx.admin.privateConnectionId));
    }
  });

  test('reissue returns a new client id and the old connection is revoked', async () => {
    const oldId = fx.owner.privateConnectionId;
    const before = await hit('GET', '/api/my/mcp', fx.owner.cookie);
    expect(before.status).toBe(200);
    const previous = await before.json() as McpBody;
    let n = 0;
    ops.setTake(async () => {
      n += 1;
      if (n > 2) throw new Error('ENOENT: no such file or directory');
      return {
        version: 1,
        mcp_url: 'https://reissue.example.test/mcp',
        client_id: `gbrain_cl_reissue_${n}`,
        client_secret: `reissue-secret-${n}-xxxxxxxxxxxx`,
      };
    });

    const res = await hit('POST', '/api/my/mcp/reissue', fx.owner.cookie);
    expect(res.status).toBe(200);
    const body = await res.json() as McpBody;
    expect(body.credentials.client_id).toBe('gbrain_cl_reissue_1');
    expect(body.credentials.client_id).not.toBe(previous.credentials.client_id);
    expect(body.credentials.client_secret).toBe('reissue-secret-1-xxxxxxxxxxxx');
    expect(body.mcp_url).toBe('https://reissue.example.test/mcp');
    expect(body.harness).toBe('generic');
    expect(body.snippet).toBe(wiringSnippet('generic', {
      client_id: 'gbrain_cl_reissue_1',
      mcp_url: 'https://reissue.example.test/mcp',
    }, { skills: false }));
    expect(JSON.stringify(body)).not.toContain('reissue-secret-2-xxxxxxxxxxxx');
    expect(ops.calls.some((c) => c.params && 'reissue' in c.params)).toBe(false);

    const [old] = await getDb().select().from(schema.connections).where(eq(schema.connections.id, oldId));
    expect(old?.state).toBe('revoked');
    const active = await getDb().select().from(schema.connections).where(and(
      eq(schema.connections.membershipId, fx.owner.membershipId),
      eq(schema.connections.writeSpaceId, fx.owner.privateSpaceId),
      eq(schema.connections.state, 'active'),
    ));
    expect(active).toHaveLength(1);
    expect(active[0]?.id).not.toBe(oldId);

    ops.setTake(async () => { throw new Error('ENOENT: no such file or directory'); });
    const again = await hit('GET', '/api/my/mcp', fx.owner.cookie);
    expect(again.status).toBe(200);
    expect((await again.json() as McpBody).credentials).toEqual(body.credentials);
  });
});

describe('export, commit, schema, and offboard stay inside the zone', () => {
  test("an owner export of Alice's private source is 404 and not a bundle", async () => {
    const res = await hit('GET', `/api/spaces/${fx.alice.privateSourceId}/export`, fx.owner.cookie);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toContain('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(await res.json()).toEqual({ error: 'space_not_found' });
  });

  test("an owner commit of Alice's private connection is 404", async () => {
    const res = await hit('POST', `/api/connections/${fx.alice.privateConnectionId}/commit`, fx.owner.cookie, {
      message: 'should not land',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'connection not found' });
  });

  test('schema source list omits Alice; brain-wide scaffold does not receive her source id', async () => {
    const listed = await hit('GET', '/api/schema/sources', fx.owner.cookie);
    expect(listed.status).toBe(200);
    const sources = await listed.json() as { sources: Array<{ sourceId: string }> };
    const ids = sources.sources.map((s) => s.sourceId);
    expect(ids).not.toContain(fx.alice.privateSourceId);
    expect(ids).toContain(fx.companySourceId);
    expect(ids).toContain(fx.owner.privateSourceId);

    ops.reset();
    const scaffold = await hit('POST', '/api/schema/scaffold', fx.owner.cookie, {});
    expect(scaffold.status).toBe(200);
    const body = await scaffold.json() as { results: Array<{ sourceId: string }> };
    const scaffolded = body.results.map((r) => r.sourceId);
    expect(scaffolded).not.toContain(fx.alice.privateSourceId);
    expect(scaffolded).not.toContain(fx.owner.privateSourceId);
    expect(scaffolded).toContain(fx.companySourceId);
  });

  test('offboard of Alice does not leave her Space readable as a company Space', async () => {
    const sourceId = fx.alice.privateSourceId;
    const spaceId = fx.alice.privateSpaceId;
    const res = await hit('DELETE', `/api/members/${fx.alice.membershipId}`, fx.owner.cookie);
    expect(res.status).toBe(200);

    const [space] = await getDb().select().from(schema.spaces).where(eq(schema.spaces.id, spaceId));
    expect(space).toBeUndefined();

    const files = await hit('GET', `/api/spaces/${sourceId}/files`, fx.owner.cookie);
    expect(files.status).toBe(404);
    const sources = await (await hit('GET', '/api/sources', fx.owner.cookie)).json() as {
      sources: Array<{ sourceId: string }>;
    };
    expect(sources.sources.map((s) => s.sourceId)).not.toContain(sourceId);
    const spaces = await (await hit('GET', '/api/spaces', fx.owner.cookie)).json() as {
      spaces: Array<{ id: string }>;
    };
    expect(spaces.spaces.some((s) => s.id === spaceId)).toBe(false);
  });
});

describe('/api/spaces carries the zone', () => {
  test("a member's own Space is personal, a granted one is company", async () => {
    const body = await (await hit('GET', '/api/spaces', fx.bob.cookie)).json() as { spaces: Array<{ id: string; zone: string }> };
    expect(body.spaces.find((s) => s.id === fx.bob.privateSpaceId)?.zone).toBe('personal');
    const company = body.spaces.find((s) => s.id === fx.companySpaceId);
    if (company) expect(company.zone).toBe('company');
  });
});
