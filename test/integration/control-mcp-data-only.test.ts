import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

installOpsMock();

const { buildZoneFixture, hit } = await import('../helpers/zoneFixture.ts');
const { bearerFor, clientIdOf, rpc } = await import('../helpers/controlMcp.ts');
const { clearCallerCache } = await import('../../src/control/mcp/caller.ts');
const { getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { eq } = await import('drizzle-orm');

pinDb();

let fx: Awaited<ReturnType<typeof buildZoneFixture>>;
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

beforeAll(async () => { fx = await buildZoneFixture(); });
afterAll(async () => { await closeDb(); });

describe('data-only Connections', () => {
  test('new Connections are control-capable by default', async () => {
    const [row] = await getDb().select().from(schema.connections).where(eq(schema.connections.id, fx.alice.privateConnectionId));
    expect(row!.controlEnabled).toBe(true);
  });

  test('an admin turns control off; the control MCP refuses that token at once', async () => {
    const bearer = bearerFor(await clientIdOf(fx.admin.privateConnectionId));
    expect((await rpc(bearer, init)).status).toBe(200);
    const res = await hit('POST', `/api/connections/${fx.admin.privateConnectionId}/control`, fx.admin.cookie, { enabled: false });
    expect(res.status).toBe(200);
    // §7: a flag, not a credential change — the Connection is not revoked.
    const [row] = await getDb().select().from(schema.connections).where(eq(schema.connections.id, fx.admin.privateConnectionId));
    expect(row!.state).toBe('active');
    const refused = await rpc(bearer, init);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'control_disabled' });
    const audit = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'connection.control'));
    expect(audit.at(-1)!.after).toEqual({ enabled: false });
    clearCallerCache();
  });

  test('a member cannot flip it', async () => {
    const res = await hit('POST', `/api/connections/${fx.alice.privateConnectionId}/control`, fx.alice.cookie, { enabled: false });
    expect(res.status).toBe(403);
  });

  test('a non-boolean is refused', async () => {
    const res = await hit('POST', `/api/connections/${fx.alice.privateConnectionId}/control`, fx.owner.cookie, { enabled: 'no' });
    expect(res.status).toBe(400);
  });
});
