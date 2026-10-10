import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

installOpsMock();

const { buildZoneFixture } = await import('../helpers/zoneFixture.ts');
const { callerOf } = await import('../helpers/controlMcp.ts');
const { default: app } = await import('../../src/control/app.ts');
const { runTool } = await import('../../src/control/mcp/dispatch.ts');
const { getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { and, eq } = await import('drizzle-orm');
import type { ToolDef } from '../../src/control/mcp/registry.ts';

pinDb();

const ORG_GET: ToolDef = {
  name: 't_org_get', description: 'test', minRole: 'viewer', mutating: false,
  input: { type: 'object', properties: {}, additionalProperties: false },
  route: () => ({ method: 'GET', path: '/api/org' }),
};
const MEMBERS: ToolDef = {
  name: 't_members', description: 'test', minRole: 'admin', mutating: false,
  input: { type: 'object', properties: {}, additionalProperties: false },
  route: () => ({ method: 'GET', path: '/api/members' }),
};
const SPACE_FILES: ToolDef = {
  name: 't_files', description: 'test', minRole: 'viewer', mutating: false,
  input: { type: 'object', properties: { sourceId: { type: 'string' } }, required: ['sourceId'], additionalProperties: false },
  route: (a) => ({ method: 'GET', path: `/api/spaces/${encodeURIComponent(String(a.sourceId))}/files` }),
};
const TOOLS = [ORG_GET, MEMBERS, SPACE_FILES];

let fx: Awaited<ReturnType<typeof buildZoneFixture>>;
let fetches = 0;
const fetchRoute = (req: Request, env: unknown) => { fetches++; return app.fetch(req, env as never); };

const auditRows = (tool: string) => getDb().select().from(schema.auditLog)
  .where(and(eq(schema.auditLog.action, 'control_mcp.call'), eq(schema.auditLog.target, tool)));

beforeAll(async () => { fx = await buildZoneFixture(); });
beforeEach(async () => { fetches = 0; await getDb().delete(schema.auditLog); });
afterAll(async () => { await closeDb(); });

describe('runTool', () => {
  test('runs the route as the caller and audits the call as the human, via the agent', async () => {
    const caller = callerOf(fx.alice, fx.orgId, 'member');
    const r = await runTool({ tools: TOOLS, fetchRoute, caller, name: 't_org_get', args: {} });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.role).toBe('member');
    const [row] = await auditRows('t_org_get');
    expect(row!.actor).toBe(fx.alice.userId);
    expect(row!.organizationId).toBe(fx.orgId);
    expect(row!.after).toEqual({ via: 'control-mcp:parity-member', outcome: 'ok', status: 200, guard: 'viewer', argKeys: [] });
  });

  test('a tool above the caller role is unknown, audited, and never reaches the route', async () => {
    const r = await runTool({ tools: TOOLS, fetchRoute, caller: callerOf(fx.alice, fx.orgId, 'member'), name: 't_members', args: {} });
    expect(r).toMatchObject({ isError: true, structuredContent: { error: 'unknown_tool' } });
    expect(fetches).toBe(0);
    expect((await auditRows('t_members'))[0]!.after).toMatchObject({ outcome: 'refused', error: 'unknown_tool' });
  });

  test('Review focus 4: a userId argument is refused before the route, keys audited, values not', async () => {
    const r = await runTool({ tools: TOOLS, fetchRoute, caller: callerOf(fx.owner, fx.orgId, 'owner'), name: 't_org_get', args: { userId: fx.bob.userId } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toBe('invalid_arguments');
    expect(fetches).toBe(0);
    const [row] = await auditRows('t_org_get');
    expect(row!.after).toMatchObject({ outcome: 'refused', error: 'invalid_arguments', argKeys: ['userId'] });
    expect(JSON.stringify(row!.after)).not.toContain(fx.bob.userId);
  });

  test('Review focus 4: array and string arguments are refused', async () => {
    for (const args of [[], 'x']) {
      const r = await runTool({ tools: TOOLS, fetchRoute, caller: callerOf(fx.owner, fx.orgId, 'owner'), name: 't_org_get', args });
      expect(r.structuredContent.error).toBe('invalid_arguments');
    }
  });

  test('a route refusal is an isError result carrying the route status and error', async () => {
    const r = await runTool({ tools: TOOLS, fetchRoute, caller: callerOf(fx.bob, fx.orgId, 'member'), name: 't_files', args: { sourceId: fx.alice.privateSourceId } });
    expect(r.isError).toBe(true);
    expect(typeof r.structuredContent.status).toBe('number');
    expect(r.structuredContent.status).toBeGreaterThanOrEqual(400);
  });

  test('a route that throws is internal_error, audited', async () => {
    const boom = () => { throw new Error('kaput'); };
    const r = await runTool({ tools: TOOLS, fetchRoute: boom, caller: callerOf(fx.owner, fx.orgId, 'owner'), name: 't_org_get', args: {} });
    expect(r.structuredContent).toEqual({ error: 'internal_error' });
    expect((await auditRows('t_org_get'))[0]!.after).toMatchObject({ outcome: 'error', error: 'route_threw' });
  });

  test('S3c: a free-text route error value never lands in the audit row', async () => {
    const fake = () => new Response(JSON.stringify({ error: 'unknown source src-secret-123' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
    const r = await runTool({ tools: TOOLS, fetchRoute: fake, caller: callerOf(fx.owner, fx.orgId, 'owner'), name: 't_org_get', args: {} });
    expect(r.isError).toBe(true);
    const [row] = await auditRows('t_org_get');
    expect(row!.after).toMatchObject({ outcome: 'error', status: 400 });
    expect('error' in (row!.after as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(row!.after)).not.toContain('src-secret-123');
  });

  test('S3c: a code-shaped route error is still stored', async () => {
    const fake = () => new Response(JSON.stringify({ error: 'source_not_found' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
    const r = await runTool({ tools: TOOLS, fetchRoute: fake, caller: callerOf(fx.owner, fx.orgId, 'owner'), name: 't_org_get', args: {} });
    expect(r.isError).toBe(true);
    expect((await auditRows('t_org_get'))[0]!.after).toMatchObject({ outcome: 'error', error: 'source_not_found' });
  });

  test('D7: a throwing route builder is internal_error and audited as route_threw', async () => {
    const throwing: ToolDef = {
      name: 't_throws', description: 'test', minRole: 'viewer', mutating: false,
      input: { type: 'object', properties: {}, additionalProperties: false },
      route: () => { throw new Error('builder kaput'); },
    };
    const r = await runTool({ tools: [...TOOLS, throwing], fetchRoute, caller: callerOf(fx.owner, fx.orgId, 'owner'), name: 't_throws', args: {} });
    expect(r.structuredContent).toEqual({ error: 'internal_error' });
    expect((await auditRows('t_throws'))[0]!.after).toMatchObject({ outcome: 'error', error: 'route_threw' });
    expect(fetches).toBe(0);
  });
});
