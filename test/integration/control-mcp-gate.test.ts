import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

installOpsMock();

const { buildZoneFixture } = await import('../helpers/zoneFixture.ts');
const { callerOf } = await import('../helpers/controlMcp.ts');
const { default: app } = await import('../../src/control/app.ts');
const { listingOf, runTool } = await import('../../src/control/mcp/dispatch.ts');
const { getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { eq } = await import('drizzle-orm');
import type { ToolDef } from '../../src/control/mcp/registry.ts';

pinDb();

const RENAME: ToolDef = {
  name: 't_org_rename', description: 'Rename the org.', minRole: 'admin', mutating: true,
  input: { type: 'object', properties: { name: { type: 'string', maxLength: 80 } }, required: ['name'], additionalProperties: false },
  gated: {
    preview: async (args, read) => {
      const org = await read('GET', '/api/org');
      return { summary: { from: org.body.name, to: args.name }, fingerprint: String(org.body.name) };
    },
  },
  route: (a) => ({ method: 'PATCH', path: '/api/org', body: { name: a.name } }),
};

let fx: Awaited<ReturnType<typeof buildZoneFixture>>;
let fetches: string[] = [];
const fetchRoute = (req: Request, env: unknown) => { fetches.push(`${req.method} ${new URL(req.url).pathname}`); return app.fetch(req, env as never); };
const orgName = async () => (await getDb().select().from(schema.organizations).where(eq(schema.organizations.id, fx.orgId)))[0]!.name;
const call = (args: unknown) => runTool({ tools: [RENAME], fetchRoute, caller: callerOf(fx.admin, fx.orgId, 'admin'), name: 't_org_rename', args });

beforeAll(async () => { fx = await buildZoneFixture(); });
beforeEach(() => { fetches = []; });
afterAll(async () => { await closeDb(); });

describe('D6 confirm gate', () => {
  test('listing advertises confirm and the requirement', () => {
    const l = listingOf(RENAME);
    expect(Object.keys(l.inputSchema.properties)).toContain('confirm');
    expect(l.description).toContain('Requires confirmation');
    expect(l.annotations.destructiveHint).toBe(true);
  });

  test('without confirm: a preview and a token, and nothing changes', async () => {
    const before = await orgName();
    const r = await call({ name: 'Renamed Co' });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ preview: true, summary: { from: before, to: 'Renamed Co' } });
    expect(typeof r.structuredContent.confirmToken).toBe('string');
    expect(await orgName()).toBe(before);
    expect(fetches).toEqual(['GET /api/org']);
  });

  test('with the token: it acts, once', async () => {
    const { structuredContent: p } = await call({ name: 'Renamed Co' });
    const r = await call({ name: 'Renamed Co', confirm: p.confirmToken });
    expect(r.isError).toBe(false);
    expect(await orgName()).toBe('Renamed Co');
  });

  test('a token for other arguments is refused', async () => {
    const { structuredContent: p } = await call({ name: 'Alpha' });
    const r = await call({ name: 'Beta', confirm: p.confirmToken });
    expect(r.structuredContent.error).toBe('confirm_mismatch');
    expect(await orgName()).not.toBe('Beta');
  });

  test('a stale preview is refused once the state it showed has changed', async () => {
    const { structuredContent: p } = await call({ name: 'Gamma' });
    await getDb().update(schema.organizations).set({ name: 'Changed Meanwhile' }).where(eq(schema.organizations.id, fx.orgId));
    const r = await call({ name: 'Gamma', confirm: p.confirmToken });
    expect(r.structuredContent.error).toBe('confirm_mismatch');
    expect(await orgName()).toBe('Changed Meanwhile');
  });

  test('another member cannot use my token', async () => {
    const { structuredContent: p } = await call({ name: 'Delta' });
    const r = await runTool({ tools: [RENAME], fetchRoute, caller: callerOf(fx.owner, fx.orgId, 'owner'), name: 't_org_rename', args: { name: 'Delta', confirm: p.confirmToken } });
    expect(r.structuredContent.error).toBe('confirm_mismatch');
  });

  test('preview and confirm are both audited', async () => {
    await getDb().delete(schema.auditLog);
    const { structuredContent: p } = await call({ name: 'Epsilon' });
    await call({ name: 'Epsilon', confirm: p.confirmToken });
    const rows = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.target, 't_org_rename'));
    expect(rows.map((r) => (r.after as any).outcome).sort()).toEqual(['ok', 'preview']);
    expect(rows.every((r) => !JSON.stringify(r.after).includes((p.confirmToken as string).split('.')[1]!))).toBe(true);
  });
});
