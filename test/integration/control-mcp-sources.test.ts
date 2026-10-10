import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

installOpsMock();

const { buildZoneFixture } = await import('../helpers/zoneFixture.ts');
const { bearerFor, callTool, clientIdOf } = await import('../helpers/controlMcp.ts');
const { getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { and, eq } = await import('drizzle-orm');

pinDb();

let fx: Awaited<ReturnType<typeof buildZoneFixture>>;
let admin = '';
let alice = '';

const routeAudit = (action: string) => getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

beforeAll(async () => {
  fx = await buildZoneFixture();
  admin = bearerFor(await clientIdOf(fx.admin.privateConnectionId));
  alice = bearerFor(await clientIdOf(fx.alice.privateConnectionId));
});
afterAll(async () => { await closeDb(); });

describe('source and grant tools', () => {
  test('source_create makes the Space, and the route audits it as the admin', async () => {
    // `audit_log` has no FK to `organizations`, so the fixture's TRUNCATE does
    // not clear it: a sibling suite's `control_mcp.call` row for this tool would
    // otherwise be the last row here.
    await getDb().delete(schema.auditLog);
    const r = await callTool(admin, 'source_create', { sourceId: 'research', name: 'Research' });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.sourceId).toBe('research');
    const [space] = await getDb().select().from(schema.spaces)
      .where(and(eq(schema.spaces.organizationId, fx.orgId), eq(schema.spaces.sourceId, 'research')));
    expect(space).toBeDefined();
    const rows = await routeAudit('source.add');
    expect(rows.some((row) => row.actor === fx.admin.userId)).toBe(true);
    const wrapper = await getDb().select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'control_mcp.call'), eq(schema.auditLog.target, 'source_create')));
    expect((wrapper.at(-1)!.after as any)).toMatchObject({ outcome: 'ok', guard: 'admin', argKeys: ['name', 'sourceId'] });
  });

  test('source_rename changes the name', async () => {
    const r = await callTool(admin, 'source_rename', { sourceId: 'research', name: 'R&D' });
    expect(r.isError).toBe(false);
    const [space] = await getDb().select().from(schema.spaces).where(eq(schema.spaces.sourceId, 'research'));
    expect(space!.name).toBe('R&D');
  });

  test('grant_set gives alice read on the company Space', async () => {
    const r = await callTool(admin, 'grant_set', { membershipId: fx.alice.membershipId, spaceId: fx.companySpaceId, access: 'read' });
    expect(r.isError).toBe(false);
    const grants = await getDb().select().from(schema.spaceGrants)
      .where(and(eq(schema.spaceGrants.membershipId, fx.alice.membershipId), eq(schema.spaceGrants.spaceId, fx.companySpaceId)));
    expect(grants[0]!.access).toBe('read');
  });

  test('grant_set refuses a personal Space, as the route does', async () => {
    const r = await callTool(admin, 'grant_set', { membershipId: fx.bob.membershipId, spaceId: fx.alice.privateSpaceId, access: 'read' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toBe('personal_space_not_grantable');
  });

  test('a member cannot see these tools', async () => {
    expect((await callTool(alice, 'source_create', { sourceId: 'x', name: 'x' })).structuredContent.error).toBe('unknown_tool');
  });

  test('personal mode: company_mode_required passes through unchanged', async () => {
    await getDb().update(schema.organizations).set({ brainMode: 'personal' }).where(eq(schema.organizations.id, fx.orgId));
    try {
      const r = await callTool(admin, 'source_create', { sourceId: 'nope', name: 'Nope' });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({ status: 403, error: 'company_mode_required' });
    } finally {
      await getDb().update(schema.organizations).set({ brainMode: 'company' }).where(eq(schema.organizations.id, fx.orgId));
    }
  });
});
