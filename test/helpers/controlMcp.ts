// test/helpers/controlMcp.ts
import { randomUUID } from 'node:crypto';
import { expect } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { hit, PASS, type Actor } from './zoneFixture.ts';

/** Imported lazily so the test file's `installOpsMock()` runs first. */
async function deps() {
  const { default: app } = await import('../../src/control/app.ts');
  const db = await import('../../src/control/db/client.ts');
  return { app, ...db };
}

/** test/helpers/opsMock.ts's `mcpWhoami` answers `tok-<clientId>` as that OAuth client. */
export const bearerFor = (clientId: string): string => `tok-${clientId}`;

export async function clientIdOf(connectionId: string): Promise<string> {
  const { getDb, schema } = await deps();
  const [row] = await getDb().select({ id: schema.connections.gbrainClientId })
    .from(schema.connections).where(eq(schema.connections.id, connectionId));
  if (!row?.id) throw new Error(`connection ${connectionId} has no gbrain client id`);
  return row.id;
}

export async function rpc(bearer: string | null, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const { app } = await deps();
  return app.request('/api/control-mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export type ToolCallResult = { isError: boolean; structuredContent: Record<string, any> };

export async function callTool(bearer: string, name: string, args: unknown = {}): Promise<ToolCallResult> {
  const res = await rpc(bearer, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (res.status !== 200) throw new Error(`tools/call ${name}: HTTP ${res.status} ${await res.text()}`);
  const msg = await res.json() as { result?: ToolCallResult; error?: unknown };
  if (!msg.result) throw new Error(`tools/call ${name}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

export async function listTools(bearer: string): Promise<string[]> {
  const res = await rpc(bearer, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(res.status).toBe(200);
  const msg = await res.json() as { result: { tools: { name: string }[] } };
  return msg.result.tools.map((t) => t.name).sort();
}

/** A viewer with an active Connection on `spaceId`. Returns its bearer. */
export async function addViewer(orgId: string, spaceId: string): Promise<{ userId: string; membershipId: string; bearer: string }> {
  const { getDb, schema } = await deps();
  const tag = randomUUID().slice(0, 8);
  const email = `viewer-${tag}@example.test`;
  const res = await hit('POST', '/api/auth/sign-up/email', undefined, { email, password: PASS, name: email });
  expect(res.status).toBe(200);
  const [u] = await getDb().select().from(schema.users).where(sql`${schema.users.email} = ${email}`);
  const membershipId = randomUUID();
  await getDb().insert(schema.memberships).values({ id: membershipId, userId: u!.id, organizationId: orgId, role: 'viewer' });
  const clientId = `gbrain_cl_viewer_${tag}`;
  await getDb().insert(schema.connections).values({
    id: randomUUID(), organizationId: orgId, membershipId, writeSpaceId: spaceId, readSpaceIds: [],
    harness: 'generic', clientName: `bs-viewer-${tag}`, gbrainClientId: clientId,
    profile: 'read-only', tokenTtl: 3600, state: 'active',
  });
  return { userId: u!.id, membershipId, bearer: bearerFor(clientId) };
}

/** A ControlCaller for a zone-fixture actor (for direct `callRoute` tests). */
export function callerOf(actor: Actor, orgId: string, role: 'owner' | 'admin' | 'member' | 'viewer') {
  return {
    userId: actor.userId, orgId, role, membershipId: actor.membershipId,
    connectionId: actor.privateConnectionId, clientId: `parity-${role}`,
  };
}
