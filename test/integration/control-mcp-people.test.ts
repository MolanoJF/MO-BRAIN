import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

installOpsMock();

const { buildZoneFixture } = await import('../helpers/zoneFixture.ts');
const { bearerFor, callTool, callerOf, clientIdOf } = await import('../helpers/controlMcp.ts');
const { TOOLS } = await import('../../src/control/mcp/registry.ts');
const { callRoute } = await import('../../src/control/mcp/dispatch.ts');
const { default: app } = await import('../../src/control/app.ts');
const { getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { eq, sql } = await import('drizzle-orm');

pinDb();

let fx: Awaited<ReturnType<typeof buildZoneFixture>>;
let owner = '';
let admin = '';

const membersWith = async (email: string) => {
  const [u] = await getDb().select().from(schema.users).where(sql`${schema.users.email} = ${email}`);
  return u ? getDb().select().from(schema.memberships).where(eq(schema.memberships.userId, u.id)) : [];
};

beforeAll(async () => {
  fx = await buildZoneFixture();
  owner = bearerFor(await clientIdOf(fx.owner.privateConnectionId));
  admin = bearerFor(await clientIdOf(fx.admin.privateConnectionId));
});
afterAll(async () => { await closeDb(); });

describe('member_invite', () => {
  test('previews first and creates nothing', async () => {
    const p = await callTool(admin, 'member_invite', { email: 'new@example.test', role: 'member' });
    expect(p.structuredContent).toMatchObject({ preview: true, summary: { invite: 'new@example.test', role: 'member' } });
    expect(await membersWith('new@example.test')).toEqual([]);
  });

  test('confirmed, it invites; the route audits member.create as the admin', async () => {
    const p = await callTool(admin, 'member_invite', { email: 'new@example.test', role: 'member' });
    const r = await callTool(admin, 'member_invite', { email: 'new@example.test', role: 'member', confirm: p.structuredContent.confirmToken });
    expect(r.isError).toBe(false);
    expect((await membersWith('new@example.test')).length).toBe(1);
    expect(JSON.stringify(r.structuredContent)).not.toMatch(/claim/i);
    const rows = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'member.create'));
    expect(rows.some((row) => row.actor === fx.admin.userId)).toBe(true);
  });

  test('a token for a different email is refused', async () => {
    const p = await callTool(admin, 'member_invite', { email: 'a@example.test', role: 'viewer' });
    const r = await callTool(admin, 'member_invite', { email: 'b@example.test', role: 'viewer', confirm: p.structuredContent.confirmToken });
    expect(r.structuredContent.error).toBe('confirm_mismatch');
    expect(await membersWith('b@example.test')).toEqual([]);
  });

  test('an invalid role never reaches the route', async () => {
    const r = await callTool(admin, 'member_invite', { email: 'c@example.test', role: 'owner' });
    expect(r.structuredContent.error).toBe('invalid_arguments');
  });
});

describe('org_set_mode', () => {
  test('is invisible to an admin', async () => {
    expect((await callTool(admin, 'org_set_mode', { mode: 'personal' })).structuredContent.error).toBe('unknown_tool');
  });

  test('owner: preview shows from/to; confirming with a team refuses with team_exists', async () => {
    const p = await callTool(owner, 'org_set_mode', { mode: 'personal' });
    expect(p.structuredContent.summary).toMatchObject({ from: 'company', to: 'personal' });
    const r = await callTool(owner, 'org_set_mode', { mode: 'personal', confirm: p.structuredContent.confirmToken });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ status: 409, error: 'team_exists' });
  });

  test('preview binds the current mode: a change between preview and confirm is refused', async () => {
    // The preview itself must return a non-empty fingerprint (ruling: a gated
    // tool that returns no fingerprint silently loses staleness protection).
    const tool = TOOLS.find((t) => t.name === 'org_set_mode')!;
    const caller = callerOf(fx.owner, fx.orgId, 'owner');
    const read = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => {
      const r = await callRoute((req, env) => app.fetch(req, env as never), caller, method, path, body);
      return { status: r.status, body: r.body };
    };
    const preview = await tool.gated!.preview!({ mode: 'personal' }, read);
    expect(typeof preview.fingerprint).toBe('string');
    expect((preview.fingerprint as string).length).toBeGreaterThan(0);

    // And a token minted for that mode is refused once the mode moves underneath it.
    const p = await callTool(owner, 'org_set_mode', { mode: 'personal' });
    await getDb().update(schema.organizations).set({ brainMode: 'personal' }).where(eq(schema.organizations.id, fx.orgId));
    try {
      const r = await callTool(owner, 'org_set_mode', { mode: 'personal', confirm: p.structuredContent.confirmToken });
      expect(r.structuredContent.error).toBe('confirm_mismatch');
    } finally {
      await getDb().update(schema.organizations).set({ brainMode: 'company' }).where(eq(schema.organizations.id, fx.orgId));
    }
  });
});
