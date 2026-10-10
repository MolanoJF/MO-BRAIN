import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

installOpsMock();

const { buildZoneFixture } = await import('../helpers/zoneFixture.ts');
const { addViewer, bearerFor, callTool, clientIdOf } = await import('../helpers/controlMcp.ts');
const { getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { and, eq } = await import('drizzle-orm');

pinDb();

let fx: Awaited<ReturnType<typeof buildZoneFixture>>;
let alice = '';
let bob = '';
let admin = '';
let viewer = '';
let scheduleId = '';

beforeAll(async () => {
  fx = await buildZoneFixture();
  alice = bearerFor(await clientIdOf(fx.alice.privateConnectionId));
  bob = bearerFor(await clientIdOf(fx.bob.privateConnectionId));
  admin = bearerFor(await clientIdOf(fx.admin.privateConnectionId));
  viewer = (await addViewer(fx.orgId, fx.companySpaceId)).bearer;
});
afterAll(async () => { await closeDb(); });

describe('schedule tools', () => {
  test('a member schedules on their own Connection', async () => {
    const r = await callTool(alice, 'schedule_create', {
      name: 'alice-mcp-sync', connectionId: fx.alice.privateConnectionId,
      kind: 'interval', operation: 'sync', intervalSeconds: 900, params: {},
    });
    expect(r.isError).toBe(false);
    scheduleId = r.structuredContent.id;
    expect(typeof scheduleId).toBe('string');
  });

  test('…but not on someone else\'s: the route\'s zone rule holds', async () => {
    const r = await callTool(bob, 'schedule_create', {
      name: 'sneaky', connectionId: fx.alice.privateConnectionId, kind: 'interval', operation: 'sync', intervalSeconds: 900,
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.status).toBe(403);
  });

  test('schedule_update disables it', async () => {
    const r = await callTool(alice, 'schedule_update', { id: scheduleId, enabled: false });
    expect(r.isError).toBe(false);
    const [row] = await getDb().select().from(schema.schedules).where(eq(schema.schedules.id, scheduleId));
    expect(row!.enabled).toBe(false);
  });

  test('schedule_run_now on a disabled schedule passes the 409 through', async () => {
    const r = await callTool(alice, 'schedule_run_now', { id: scheduleId });
    expect(r.structuredContent).toMatchObject({ status: 409, error: 'schedule_disabled' });
  });

  test('schedule_run_now queues a manual run once enabled', async () => {
    await callTool(alice, 'schedule_update', { id: scheduleId, enabled: true });
    const r = await callTool(alice, 'schedule_run_now', { id: scheduleId });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.run.slot).toMatch(/^manual:/);
  });

  test('a viewer cannot see the write tools', async () => {
    expect((await callTool(viewer, 'schedule_create', { name: 'v', connectionId: 'x' })).structuredContent.error).toBe('unknown_tool');
  });

  // Review finding 1: `enabled` and `timezone` are update-only. POST ignores
  // both — a created schedule is ENABLED and fires in the organization's
  // timezone — so a create that passes either must be refused, not answered
  // 200 while the value is dropped. The plain create above still succeeds.
  test('create refuses the arguments the route never reads', async () => {
    const base = {
      name: 'alice-mcp-ignored', connectionId: fx.alice.privateConnectionId,
      kind: 'interval', intervalSeconds: 3600, operation: 'sync', params: {},
    };
    for (const ignored of [{ enabled: false }, { timezone: 'America/New_York' }]) {
      const r = await callTool(alice, 'schedule_create', { ...base, ...ignored });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error).toBe('invalid_arguments');
      expect((r.structuredContent.errors as string[]).some((e) => e.startsWith('unknown argument: '))).toBe(true);
    }
    const rows = await getDb().select().from(schema.schedules).where(eq(schema.schedules.name, 'alice-mcp-ignored'));
    expect(rows).toEqual([]);
  });

  // Review finding 2: the route refuses any `notifies` that is not a boolean
  // (`invalid_notifies`, routes/schedules.ts:359). The declared type is the
  // boolean the route reads, so a non-boolean is `invalid_arguments` here.
  test('notifies is the boolean the route reads, on create and on update', async () => {
    const base = {
      name: 'alice-mcp-notifies', connectionId: fx.alice.privateConnectionId,
      kind: 'interval', intervalSeconds: 3600, operation: 'sync', params: {},
    };
    for (const bad of ['yes', {}]) {
      const r = await callTool(alice, 'schedule_create', { ...base, notifies: bad });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error).toBe('invalid_arguments');
      expect((r.structuredContent.errors as string[]).some((e) => e.startsWith('notifies '))).toBe(true);
    }
    const created = await callTool(alice, 'schedule_create', { ...base, notifies: true });
    expect(created.isError).toBe(false);
    const updated = await callTool(alice, 'schedule_update', { id: scheduleId, notifies: true });
    expect(updated.isError).toBe(false);
    const [row] = await getDb().select().from(schema.schedules).where(eq(schema.schedules.id, created.structuredContent.id));
    expect(row!.notifies).toBe(true);
  });

  // Ruling 8 / S3c: the MCP's own audit row for a write carries the argument
  // KEYS and nothing else — no values, no response body, no bearer.
  test('the control_mcp.call row for a write carries keys, never values', async () => {
    await getDb().delete(schema.auditLog);
    await callTool(alice, 'schedule_update', { id: scheduleId, enabled: true });
    const rows = await getDb().select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'control_mcp.call'), eq(schema.auditLog.target, 'schedule_update')));
    const after = rows.at(-1)!.after as Record<string, unknown>;
    expect(after.argKeys).toEqual(['enabled', 'id']);
    expect(Object.keys(after).sort()).toEqual(['argKeys', 'guard', 'outcome', 'status', 'via']);
    expect(JSON.stringify(after)).not.toContain(scheduleId);
  });

  // Ruling 7: an argument the route reads only in one lane can never widen the
  // mutation by being omitted. Here the agent payload is supplied without
  // `jobType` and without a command `operation`, which is the shape that would
  // otherwise fall back to the command lane: the route refuses, and no row is
  // written. The Connection, which is what fences the run's scope, is required.
  test('an omitted lane discriminator creates nothing', async () => {
    const r = await callTool(alice, 'schedule_create', {
      name: 'alice-mcp-lane-less', connectionId: fx.alice.privateConnectionId,
      kind: 'interval', intervalSeconds: 900,
      agentPrompt: 'summarize the week', agentModel: 'claude-sonnet-5', agentMaxTokens: 4096, agentBudgetUsd: '1.00',
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toBe('unknown_operation');
    const rows = await getDb().select().from(schema.schedules).where(eq(schema.schedules.name, 'alice-mcp-lane-less'));
    expect(rows).toEqual([]);
  });
});

describe('connection_create', () => {
  const args = () => ({ membershipId: fx.alice.membershipId, writeSpaceId: fx.companySpaceId, readSpaceIds: [], harness: 'generic' });

  test('previews the grant and creates nothing', async () => {
    const before = await getDb().select().from(schema.connections).where(eq(schema.connections.writeSpaceId, fx.companySpaceId));
    const p = await callTool(admin, 'connection_create', args());
    expect(p.structuredContent.preview).toBe(true);
    const after = await getDb().select().from(schema.connections).where(eq(schema.connections.writeSpaceId, fx.companySpaceId));
    expect(after.length).toBe(before.length);
  });

  test('confirmed, it creates a pending Connection with no secret in the result', async () => {
    const p = await callTool(admin, 'connection_create', args());
    const r = await callTool(admin, 'connection_create', { ...args(), confirm: p.structuredContent.confirmToken });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.state).toBe('pending');
    expect(JSON.stringify(r.structuredContent)).not.toMatch(/access_token|client_secret/);
    const [row] = await getDb().select().from(schema.connections)
      .where(and(eq(schema.connections.id, r.structuredContent.id), eq(schema.connections.organizationId, fx.orgId)));
    expect(row!.state).toBe('pending');
  });

  test('a personal Space is refused, as in the console', async () => {
    const p = await callTool(admin, 'connection_create', { ...args(), writeSpaceId: fx.alice.privateSpaceId });
    const r = await callTool(admin, 'connection_create', { ...args(), writeSpaceId: fx.alice.privateSpaceId, confirm: p.structuredContent.confirmToken });
    expect(r.isError).toBe(true);
  });

  // Ruling 4: the token binds the preview's own result, so a Connection state
  // that changed between the preview and the confirm is refused rather than
  // silently confirmed. `bob` is the target here because his client name takes
  // no Connection the test above created.
  test('a Connection state that changed between preview and confirm is refused', async () => {
    const forBob = { membershipId: fx.bob.membershipId, writeSpaceId: fx.companySpaceId, readSpaceIds: [], harness: 'generic' };
    const p = await callTool(admin, 'connection_create', forBob);
    // The membership's role IS the grant profile the preview showed.
    await getDb().update(schema.memberships).set({ role: 'admin' }).where(eq(schema.memberships.id, fx.bob.membershipId));
    try {
      const r = await callTool(admin, 'connection_create', { ...forBob, confirm: p.structuredContent.confirmToken });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error).toBe('confirm_mismatch');
    } finally {
      await getDb().update(schema.memberships).set({ role: 'member' }).where(eq(schema.memberships.id, fx.bob.membershipId));
    }
  });
});
