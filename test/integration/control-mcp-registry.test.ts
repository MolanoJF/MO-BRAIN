import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

installOpsMock();

const { buildZoneFixture } = await import('../helpers/zoneFixture.ts');
const { addViewer, bearerFor, callTool, callerOf, clientIdOf, listTools } = await import('../helpers/controlMcp.ts');
const { TOOLS } = await import('../../src/control/mcp/registry.ts');
const { callRoute } = await import('../../src/control/mcp/dispatch.ts');
const { ROLE_RANK } = await import('../../src/control/rbac.ts');
const { default: app } = await import('../../src/control/app.ts');
const { getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { and, eq } = await import('drizzle-orm');
import type { ToolDef } from '../../src/control/mcp/registry.ts';

pinDb();

let fx: Awaited<ReturnType<typeof buildZoneFixture>>;
const bearers: Record<'viewer' | 'member' | 'admin' | 'owner', string> = { viewer: '', member: '', admin: '', owner: '' };

/** Any value of the right type for every required argument. */
function sampleArgs(tool: ToolDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of tool.input.required ?? []) {
    const p = tool.input.properties[key]!;
    const t = Array.isArray(p.type) ? p.type[0] : p.type;
    out[key] = p.enum ? p.enum[0] : t === 'string' ? 'sample' : t === 'integer' || t === 'number' ? 1
      : t === 'boolean' ? false : t === 'array' ? [] : {};
  }
  return out;
}

beforeAll(async () => {
  fx = await buildZoneFixture();
  bearers.owner = bearerFor(await clientIdOf(fx.owner.privateConnectionId));
  bearers.admin = bearerFor(await clientIdOf(fx.admin.privateConnectionId));
  bearers.member = bearerFor(await clientIdOf(fx.alice.privateConnectionId));
  bearers.viewer = (await addViewer(fx.orgId, fx.companySpaceId)).bearer;
});
afterAll(async () => { await closeDb(); });

describe('registry invariants', () => {
  test('names are unique snake_case verbs-on-nouns', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z]+(_[a-z]+)+$/);
  });

  test('every tool\'s minRole equals the guard its route actually enforces', async () => {
    const owner = callerOf(fx.owner, fx.orgId, 'owner');
    const mismatches: string[] = [];
    for (const tool of TOOLS) {
      const req = tool.route(sampleArgs(tool));
      const reply = await callRoute((r, env) => app.fetch(r, env as never), owner, req.method, req.path, req.body);
      if (reply.guard !== tool.minRole) mismatches.push(`${tool.name}: registry=${tool.minRole} route=${reply.guard} (HTTP ${reply.status})`);
    }
    expect(mismatches).toEqual([]);
  });

  test('every mutating tool requires at least one argument (so the audit sweep never mutates)', () => {
    for (const tool of TOOLS.filter((t) => t.mutating)) {
      expect(`${tool.name}:${(tool.input.required ?? []).length > 0}`).toBe(`${tool.name}:true`);
    }
  });

  test('every gated tool declares a preview (a bare `gated: {}` would silently lose staleness protection)', () => {
    const offenders = TOOLS.filter((t) => t.gated && typeof t.gated.preview !== 'function').map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  test('confused deputy: no tool declares an identity argument', () => {
    for (const tool of TOOLS) {
      for (const key of Object.keys(tool.input.properties)) {
        expect(['userId', 'actor', 'actorId', 'orgId', 'organizationId', 'role']).not.toContain(key);
      }
    }
  });

  test('no tool reaches a surface v1 excludes', () => {
    const banned = /^\/api\/(my\/|auth\/|runs\/claim|gateway|backup|upgrades|control-mcp|wizard)|claim-link|\/commit$|\/export$|\/revoke$/;
    for (const tool of TOOLS) {
      const { path, method } = tool.route(sampleArgs(tool));
      expect(`${tool.name} ${path}`).not.toMatch(banned);
      expect(method === 'DELETE' ? tool.name : '').toBe('');
    }
  });

  test('tools/list is filtered by role', async () => {
    for (const role of ['viewer', 'member', 'admin', 'owner'] as const) {
      const expected = TOOLS.filter((t) => ROLE_RANK[role] >= ROLE_RANK[t.minRole]).map((t) => t.name).sort();
      expect(await listTools(bearers[role])).toEqual(expected);
    }
    expect(await listTools(bearers.member)).toContain('schedule_list');
    expect(await listTools(bearers.member)).not.toContain('member_list');
  });

  test('D7: every tool call writes a control_mcp.call row, even a refused one', async () => {
    await getDb().delete(schema.auditLog);
    for (const tool of TOOLS) {
      await callTool(bearers.owner, tool.name, {});
      const rows = await getDb().select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, 'control_mcp.call'), eq(schema.auditLog.target, tool.name)));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]!.actor).toBe(fx.owner.userId);
      expect((rows[0]!.after as any).via).toMatch(/^control-mcp:/);
    }
  });

  test('a member calling an admin tool is told it does not exist', async () => {
    const r = await callTool(bearers.member, 'source_list');
    expect(r).toMatchObject({ isError: true, structuredContent: { error: 'unknown_tool' } });
  });

  test('org_get answers as the caller', async () => {
    const r = await callTool(bearers.member, 'org_get');
    expect(r.isError).toBe(false);
    expect(r.structuredContent.role).toBe('member');
    expect(r.structuredContent.brainMode).toBe('company');
  });
});
