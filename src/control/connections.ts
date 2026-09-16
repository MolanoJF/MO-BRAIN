import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import { callOps } from './opsClient.ts';
import type { Role } from './rbac.ts';
import {
  clientName,
  compileConnection,
  diffCompiled,
  type CompiledConnection,
} from '../contracts/compile.ts';

/** Ops-side --credentials-out path. Claim takes (reads+deletes) this file once. */
export function grantCredentialsOutPath(connectionId: string): string {
  return `/srv/gbrain-home/.creds-${connectionId}.json`;
}

export type ConnectionInput = {
  organizationId: string;
  membershipId: string;
  writeSpaceId: string;
  readSpaceIds: string[];
  harness: string;
  memberRole: Role;
  /** Existing connection id. Absent => new grant preview/provision. */
  connectionId?: string;
  boundSlugPrefixes?: string[];
  tokenTtl?: number;
  budgetUsdPerDay?: number;
};

type SpaceRow = typeof schema.spaces.$inferSelect;
type ConnectionRow = typeof schema.connections.$inferSelect;

/** Confirm screen. New connections get a REAL server preview (mcp grant --dry-run). */
export async function previewConnection(input: ConnectionInput): Promise<{
  compiled: CompiledConnection;
  serverPreview: unknown | null;
  diff: ReturnType<typeof diffCompiled>;
  previewSource: 'server' | 'computed';
}> {
  const { write, reads } = await loadSpaces(input.organizationId, input.writeSpaceId, input.readSpaceIds);
  const compiled = compileFrom(input, write, reads);
  const name = clientName(input.membershipId, write.sourceId);
  const existing = await loadOptionalConnection(input.connectionId, input.organizationId);
  await assertNoCollision(input.organizationId, name, existing?.id);

  // V18: auth.rescopeClient has no --dry-run at this pin. Scope changes are a
  // computed diff, never a fake grant preview and never a mutating rescope.
  if (existing?.state === 'active' && existing.gbrainClientId) {
    const before = await compileStored(existing, input.memberRole);
    return {
      compiled,
      serverPreview: null,
      diff: diffCompiled(before, compiled),
      previewSource: 'computed',
    };
  }

  const r = await callOps('mcp.grant', grantParams(name, input.harness, compiled), {
    json: true,
    dryRun: true,
  });
  if (!r.ok) throw new Error(`mcp.grant preview failed (exit ${r.exitCode})`);
  return {
    compiled,
    serverPreview: r.json,
    diff: diffCompiled(null, compiled),
    previewSource: 'server',
  };
}

export async function provisionConnection(
  input: ConnectionInput,
  actor: string,
): Promise<{ connectionId: string; credentials: unknown }> {
  await assertMembership(input.organizationId, input.membershipId);
  const { write, reads } = await loadSpaces(input.organizationId, input.writeSpaceId, input.readSpaceIds);
  const compiled = compileFrom(input, write, reads);
  const name = clientName(input.membershipId, write.sourceId);
  const existing = await loadOptionalConnection(input.connectionId, input.organizationId);
  await assertNoCollision(input.organizationId, name, existing?.id);

  if (existing?.state === 'active' && existing.gbrainClientId) {
    const clientId = existing.gbrainClientId;
    const r = await callOps(
      'auth.rescopeClient',
      rescopeParams(clientId, compiled),
      { json: true },
    );
    if (!r.ok) throw new Error(`auth.rescopeClient failed (exit ${r.exitCode})`);
    await persistCompiled(existing.id, input, name, compiled);
    await audit(input.organizationId, actor, 'connection.rescope', existing.id, {
      clientId, clientName: name,
      writeSpace: write.sourceId, readSpaces: reads.map((s) => s.sourceId),
      profile: compiled.profile,
    });
    return { connectionId: existing.id, credentials: r.json };
  }

  const connectionId = existing ? existing.id : randomUUID();
  if (!existing) await insertPending(connectionId, input, name, compiled);

  const credentialsOut = grantCredentialsOutPath(connectionId);
  const r = await callOps(
    'mcp.grant',
    grantParams(name, input.harness, compiled, credentialsOut),
    { json: true },
  );
  if (!r.ok) throw new Error(`mcp.grant failed (exit ${r.exitCode})`);
  const gbrainClientId = grantedClientId(r.json);
  await persistCompiled(connectionId, input, name, compiled, {
    gbrainClientId,
    state: 'active',
    provisionedAt: new Date(),
  });
  await audit(input.organizationId, actor, 'connection.provision', connectionId, {
    clientId: gbrainClientId, clientName: name,
    writeSpace: write.sourceId, readSpaces: reads.map((s) => s.sourceId),
    profile: compiled.profile,
  });
  // Grant JSON is the redacted receipt (client_id, not client_secret). The
  // secret stays in the ops-side --credentials-out file; we do not cat it (S2).
  return { connectionId, credentials: r.json };
}

/** Admin POST /api/connections: persist pending, provision later at claim (A3). */
export async function createPendingConnection(
  input: ConnectionInput,
): Promise<{ connectionId: string; compiled: CompiledConnection }> {
  await assertMembership(input.organizationId, input.membershipId);
  const { write, reads } = await loadSpaces(input.organizationId, input.writeSpaceId, input.readSpaceIds);
  const compiled = compileFrom(input, write, reads);
  const name = clientName(input.membershipId, write.sourceId);
  await assertNoCollision(input.organizationId, name);
  const connectionId = randomUUID();
  await insertPending(connectionId, input, name, compiled);
  return { connectionId, compiled };
}

export async function revokeConnection(connectionId: string, actor: string): Promise<void> {
  const row = await loadConnection(connectionId);
  if (row.state === 'revoked') return;

  const snapshot = await revokeSnapshot(row);
  // A2/C4: the DELETE is irreversible and cascades to oauth_tokens + oauth_codes.
  // The audit row IS the durable record — write it before the delete, not after,
  // or a crash mid-revoke loses the only evidence the client ever existed.
  await audit(row.organizationId, actor, 'connection.revoke', connectionId, snapshot);

  if (row.gbrainClientId) {
    // G2/V15: positional clientId, no --json, no --dry-run, no --reissue.
    const r = await callOps('auth.revokeClient', { clientId: row.gbrainClientId });
    if (!r.ok) throw new Error(`auth.revokeClient failed (exit ${r.exitCode})`);
  }

  // Free the live A4 name so the same membership+write Space can be re-granted.
  // The unique index stays a live-collision tripwire; never --reissue.
  await getDb().update(schema.connections)
    .set({
      state: 'revoked',
      revokedAt: new Date(),
      clientName: retiredClientName(connectionId),
    })
    .where(eq(schema.connections.id, connectionId));
}

export function retiredClientName(connectionId: string): string {
  return `revoked:${connectionId}`;
}

/** After a failed claim grant, restore a just-revoked row so remint can retry. */
export async function compensateGrantedConnection(
  connectionId: string,
  liveClientName: string,
  actor: string,
): Promise<void> {
  try {
    await revokeConnection(connectionId, actor);
  } catch {
    // Ops may already be down; still free the live name so remint can retry.
  }
  await getDb().update(schema.connections)
    .set({
      state: 'pending',
      clientName: liveClientName,
      gbrainClientId: null,
      provisionedAt: null,
      revokedAt: null,
    })
    .where(eq(schema.connections.id, connectionId));
}

function compileFrom(input: ConnectionInput, write: SpaceRow, reads: SpaceRow[]): CompiledConnection {
  return compileConnection(
    { role: input.memberRole },
    { sourceId: write.sourceId, slug: write.sourceId },
    reads.map((s) => ({ sourceId: s.sourceId })),
    {
      boundSlugPrefixes: input.boundSlugPrefixes,
      tokenTtl: input.tokenTtl,
      budgetUsdPerDay: input.budgetUsdPerDay,
    },
  );
}

async function compileStored(row: ConnectionRow, role: Role): Promise<CompiledConnection> {
  const readIds = asStringArray(row.readSpaceIds);
  const { write, reads } = await loadSpaces(row.organizationId, row.writeSpaceId, readIds);
  const prefixes = Array.isArray(row.boundSlugPrefixes) ? row.boundSlugPrefixes as string[] : undefined;
  return compileConnection(
    { role },
    { sourceId: write.sourceId, slug: write.sourceId },
    reads.map((s) => ({ sourceId: s.sourceId })),
    {
      boundSlugPrefixes: prefixes,
      tokenTtl: row.tokenTtl,
      budgetUsdPerDay: row.budgetUsdPerDay != null ? Number(row.budgetUsdPerDay) : undefined,
    },
  );
}

async function loadSpaces(orgId: string, writeSpaceId: string, readSpaceIds: string[]) {
  const ids = [...new Set([writeSpaceId, ...readSpaceIds])];
  const rows = await getDb().select().from(schema.spaces).where(and(
    eq(schema.spaces.organizationId, orgId),
    inArray(schema.spaces.id, ids),
  ));
  const byId = new Map(rows.map((s) => [s.id, s]));
  const write = byId.get(writeSpaceId);
  if (!write) throw new Error(`write space ${writeSpaceId} not found`);
  const reads = readSpaceIds.map((id) => {
    const space = byId.get(id);
    if (!space) throw new Error(`read space ${id} not found`);
    return space;
  });
  return { write, reads };
}

async function assertMembership(orgId: string, membershipId: string): Promise<void> {
  const [row] = await getDb().select({ id: schema.memberships.id }).from(schema.memberships)
    .where(and(
      eq(schema.memberships.id, membershipId),
      eq(schema.memberships.organizationId, orgId),
    ));
  if (!row) throw new Error(`membership ${membershipId} not found`);
}

async function loadConnection(id: string): Promise<ConnectionRow> {
  const [row] = await getDb().select().from(schema.connections).where(eq(schema.connections.id, id));
  if (!row) throw new Error(`connection ${id} not found`);
  return row;
}

async function loadOptionalConnection(id: string | undefined, orgId: string): Promise<ConnectionRow | null> {
  if (!id) return null;
  const row = await loadConnection(id);
  if (row.organizationId !== orgId) throw new Error(`connection ${id} not found`);
  if (row.state === 'revoked') throw new Error(`connection ${id} is revoked`);
  return row;
}

/** A4: fail loudly on a duplicate client name. Never --reissue. */
async function assertNoCollision(orgId: string, name: string, exceptId?: string): Promise<void> {
  const [row] = await getDb().select({ id: schema.connections.id }).from(schema.connections)
    .where(and(
      eq(schema.connections.organizationId, orgId),
      eq(schema.connections.clientName, name),
    ));
  if (row && row.id !== exceptId) {
    throw new Error(`client name ${name} is already used in this organization`);
  }
}

function grantParams(
  name: string,
  harness: string,
  compiled: CompiledConnection,
  credentialsOut?: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    name,
    harness,
    profile: compiled.profile,
    source: compiled.sourceId,
    url: mcpUrl(),
    tokenTtl: String(compiled.tokenTtl),
  };
  if (compiled.federatedRead.length > 0) params.federatedRead = compiled.federatedRead;
  if (compiled.boundSlugPrefixes !== null) params.boundSlugPrefixes = compiled.boundSlugPrefixes.join(',');
  if (compiled.budgetUsdPerDay !== null) params.budgetUsdPerDay = String(compiled.budgetUsdPerDay);
  if (credentialsOut) params.credentialsOut = credentialsOut;
  return params;
}

function rescopeParams(clientId: string, compiled: CompiledConnection): Record<string, unknown> {
  const params: Record<string, unknown> = {
    id: clientId,
    source: compiled.sourceId,
    profile: compiled.profile,
    surface: compiled.surface,
  };
  // Empty list is omitted by buildArgv; a blank value still emits the flag so
  // rescope can clear federated reads. 'none' clears a write fence.
  params.federatedRead = compiled.federatedRead.length > 0 ? compiled.federatedRead : '';
  params.boundSlugPrefixes = compiled.boundSlugPrefixes === null
    ? 'none'
    : compiled.boundSlugPrefixes.join(',');
  if (compiled.budgetUsdPerDay !== null) params.budgetUsdPerDay = String(compiled.budgetUsdPerDay);
  return params;
}

export function mcpUrl(): string {
  const base = (process.env.PUBLIC_URL ?? 'http://127.0.0.1:3131').replace(/\/+$/, '');
  return base.endsWith('/mcp') ? base : `${base}/mcp`;
}

function grantedClientId(json: unknown): string {
  if (!json || typeof json !== 'object') throw new Error('mcp.grant json did not include a client id');
  const body = json as Record<string, unknown>;
  const grant = body.grant && typeof body.grant === 'object' ? body.grant as Record<string, unknown> : undefined;
  // Pin receipt (credentialReceipt) has top-level client_id and credentials:'private-file'
  // (a string). Only treat credentials as nested if it is an object.
  const creds = body.credentials && typeof body.credentials === 'object'
    ? body.credentials as Record<string, unknown>
    : undefined;
  for (const v of [
    body.client_id, body.clientId,
    grant?.clientId, grant?.client_id,
    creds?.client_id, creds?.clientId,
  ]) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  throw new Error('mcp.grant json did not include a client id');
}

async function insertPending(
  id: string,
  input: ConnectionInput,
  name: string,
  compiled: CompiledConnection,
): Promise<void> {
  try {
    await getDb().insert(schema.connections).values({
      id,
      organizationId: input.organizationId,
      membershipId: input.membershipId,
      writeSpaceId: input.writeSpaceId,
      readSpaceIds: input.readSpaceIds,
      harness: input.harness,
      clientName: name,
      profile: compiled.profile,
      tokenTtl: compiled.tokenTtl,
      budgetUsdPerDay: compiled.budgetUsdPerDay != null ? String(compiled.budgetUsdPerDay) : null,
      boundSlugPrefixes: compiled.boundSlugPrefixes,
      state: 'pending',
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new Error(`client name ${name} is already used in this organization`);
    throw e;
  }
}

async function persistCompiled(
  id: string,
  input: ConnectionInput,
  name: string,
  compiled: CompiledConnection,
  extra: { gbrainClientId?: string; state?: string; provisionedAt?: Date } = {},
): Promise<void> {
  await getDb().update(schema.connections).set({
    writeSpaceId: input.writeSpaceId,
    readSpaceIds: input.readSpaceIds,
    harness: input.harness,
    clientName: name,
    profile: compiled.profile,
    tokenTtl: compiled.tokenTtl,
    budgetUsdPerDay: compiled.budgetUsdPerDay != null ? String(compiled.budgetUsdPerDay) : null,
    boundSlugPrefixes: compiled.boundSlugPrefixes,
    ...extra,
  }).where(eq(schema.connections.id, id));
}

async function revokeSnapshot(row: ConnectionRow): Promise<Record<string, unknown>> {
  const readIds = asStringArray(row.readSpaceIds);
  try {
    const { write, reads } = await loadSpaces(row.organizationId, row.writeSpaceId, readIds);
    return {
      clientId: row.gbrainClientId,
      clientName: row.clientName,
      writeSpace: write.sourceId,
      readSpaces: reads.map((s) => s.sourceId),
      profile: row.profile,
    };
  } catch {
    return {
      clientId: row.gbrainClientId,
      clientName: row.clientName,
      writeSpace: row.writeSpaceId,
      readSpaces: readIds,
      profile: row.profile,
    };
  }
}

async function audit(orgId: string, actor: string, action: string, target: string, after: unknown): Promise<void> {
  // S3c: `after` is a redacted summary — never credentials or a request body.
  await getDb().insert(schema.auditLog).values({
    id: randomUUID(),
    organizationId: orgId,
    actor,
    action,
    target,
    before: null,
    after: after as object,
  });
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; errno?: string; cause?: { code?: string; errno?: string } };
  const code = err.errno ?? err.code ?? err.cause?.errno ?? err.cause?.code;
  return code === '23505';
}
