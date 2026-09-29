import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import { callOps, deleteCredentialJournal, takeGrantCredentials } from './opsClient.ts';
import { storeSecret } from './secrets.ts';
import { connectionClass } from './harness.ts';
import type { Role } from './rbac.ts';
import {
  clientName,
  compileConnection,
  diffCompiled,
  GRANT_PROFILES,
  type CompiledConnection,
  type GrantProfileId,
} from '../contracts/compile.ts';

/** Manual harnesses (generic, ChatGPT, Cursor, …) have no auto-refresh, so a
 *  pasted credential must outlive one copy/paste, not one hour. */
const MANUAL_HARNESS_TOKEN_TTL = 30 * 24 * 60 * 60;

/** Ops-side --credentials-out path for the member client. Taken once on a fresh grant. */
export function grantCredentialsOutPath(connectionId: string): string {
  return `/srv/gbrain-home/.creds-${connectionId}.json`;
}

/**
 * D8: the Connection's SECOND client — the server-side one, provisioned from the
 * same `compileConnection` output as the member's. Suffixed from the member's
 * deterministic name so `auth clients` shows the pair together; unique per org by
 * construction because the member name is (`connections_org_client_name_uq`).
 */
export function serverClientName(memberClientName: string): string {
  return `${memberClientName}-server`;
}

/** Where the server client's secret lives: envelope-encrypted, never on a row. */
export function serverClientSecretName(connectionId: string): string {
  return `connection:${connectionId}:server_client`;
}

/** Where the member client's secret lives: envelope-encrypted, never on a row. */
export function memberClientSecretName(connectionId: string): string {
  return `connection:${connectionId}:member_client`;
}

/** Ops-side handoff for the server client. Taken once, then deleted (S2/S3c). */
export function serverCredentialsOutPath(connectionId: string): string {
  return `/srv/gbrain-home/.creds-${connectionId}-server.json`;
}

/** Ops-side handoff for one RUN's client. Suffix is a short random hex tag. */
export function runCredentialsOutPath(suffix: string): string {
  return `/srv/gbrain-home/.creds-run-${suffix}.json`;
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

type VerifyResult = { status: 'ok' | 'partial' | 'failed'; message: string | null };

/**
 * Only for manual-class harnesses — auto-install classes write real adapter
 * config via `gbrain connect --install` and have their own install-time
 * verification story. Never throws: a verify failure is recorded, not fatal
 * to provisioning (the credential is still valid even if the live check
 * couldn't complete, e.g. a transient network blip to gbrain-ops).
 */
async function verifyManualHarness(
  clientId: string,
  harness: string,
  credentialsFile: string,
): Promise<VerifyResult | null> {
  if (connectionClass(harness) !== 'manual') return null;
  try {
    const r = await callOps('mcp.verify', {
      client: clientId, harness, url: mcpUrl(), credentialsFile, timeoutMs: 30_000,
    }, { json: true, timeoutMs: 35_000 });
    // mcp.verify's own exit-code contract (registry.ts comment, V10/honesty
    // rule 5): 0 = ok, 2 = partial (server checks passed, harness evidence
    // missing — never render this as a pass), anything else = failed.
    const status: VerifyResult['status'] = r.exitCode === 0 ? 'ok' : r.exitCode === 2 ? 'partial' : 'failed';
    return { status, message: r.stdout.slice(0, 500) || null };
  } catch (e) {
    return { status: 'failed', message: e instanceof Error ? e.message.slice(0, 500) : 'verify request failed' };
  }
}

export async function provisionConnection(
  input: ConnectionInput,
  actor: string,
): Promise<{ connectionId: string; credentials: unknown; memberHandoff?: unknown; verify: VerifyResult | null }> {
  await assertMembership(input.organizationId, input.membershipId);
  const { write, reads } = await loadSpaces(input.organizationId, input.writeSpaceId, input.readSpaceIds);
  const compiled = compileFrom(input, write, reads);
  const name = clientName(input.membershipId, write.sourceId);
  const existing = await loadOptionalConnection(input.connectionId, input.organizationId);
  await assertNoCollision(input.organizationId, name, existing?.id);

  if (existing?.state === 'active' && existing.gbrainClientId) {
    const clientId = existing.gbrainClientId;
    // D8: the pair stays identical through a rescope, and the server client goes
    // first — if it fails, nothing the member's own client depends on has moved
    // yet, so a failure leaves one state rather than two.
    if (existing.serverClientId) {
      const rs = await callOps(
        'auth.rescopeClient',
        rescopeParams(existing.serverClientId, compiled),
        { json: true },
      );
      if (!rs.ok) throw new Error(`auth.rescopeClient (server client) failed (exit ${rs.exitCode})`);
    }
    const r = await callOps(
      'auth.rescopeClient',
      rescopeParams(clientId, compiled),
      { json: true },
    );
    if (!r.ok) throw new Error(`auth.rescopeClient failed (exit ${r.exitCode})`);
    // A rescope never re-runs verify, so any prior verify result is stale for
    // the connection's new scope (e.g. a different harness or profile) —
    // clear it explicitly rather than leaving a misleading "Verified" stick.
    await persistCompiled(existing.id, input, name, compiled, {
      verifyStatus: null,
      verifiedAt: null,
      verifyMessage: null,
    });
    await audit(input.organizationId, actor, 'connection.rescope', existing.id, {
      clientId, serverClientId: existing.serverClientId, clientName: name,
      writeSpace: write.sourceId, readSpaces: reads.map((s) => s.sourceId),
      profile: compiled.profile,
    });
    return { connectionId: existing.id, credentials: r.json, verify: null };
  }

  const connectionId = existing ? existing.id : randomUUID();
  if (!existing) await insertPending(connectionId, input, name, compiled);

  const credentialsOut = grantCredentialsOutPath(connectionId);
  const r = await callOps(
    'mcp.grant',
    grantParams(name, input.harness, compiled, credentialsOut),
    { json: true },
  );
  if (!r.ok) throw new Error(`mcp.grant failed (exit ${r.exitCode}): ${String(r.stderr ?? '').slice(0, 500)}`);
  const gbrainClientId = grantedClientId(r.json);

  const verifyResult = await verifyManualHarness(gbrainClientId, input.harness, credentialsOut);

  // D8: the server-side client, alongside the member's. Same compiler output —
  // same write Space, same federatedRead, same fence, same profile — because it
  // is the same `compiled`. Its secret goes to `secrets`, not to a row.
  // The member handoff is taken first, before that second grant. A failure
  // after the member client exists revokes it in the catch below.
  let serverClientId: string;
  let memberHandoff: unknown;
  try {
    memberHandoff = await storeMemberClientHandoff(
      input.organizationId, connectionId, gbrainClientId, credentialsOut,
    );
    serverClientId = await provisionServerClient(
      connectionId, input.organizationId, name, input.harness, compiled,
    );
  } catch (e) {
    // Half a Connection is worse than none: the member client we just minted
    // would be live with no row and no audit naming it. Revoke it and rethrow,
    // so a retry re-mints both (never --reissue, never a duplicate name).
    try {
      await callOps('auth.revokeClient', { clientId: gbrainClientId });
    } catch {
      // Ops may be unreachable; the throw below is the operator's signal.
    }
    throw e;
  }
  try {
    await applySurface(gbrainClientId, compiled);
  } catch (e) {
    for (const id of [gbrainClientId, serverClientId]) {
      try { await callOps('auth.revokeClient', { clientId: id }); } catch { /* operator signal is the throw */ }
    }
    throw e;
  }

  await persistCompiled(connectionId, input, name, compiled, {
    gbrainClientId,
    serverClientId,
    state: 'active',
    provisionedAt: new Date(),
    verifyStatus: verifyResult?.status,
    verifiedAt: verifyResult ? new Date() : undefined,
    verifyMessage: verifyResult?.message ?? undefined,
  });
  await audit(input.organizationId, actor, 'connection.provision', connectionId, {
    clientId: gbrainClientId, serverClientId, clientName: name,
    writeSpace: write.sourceId, readSpaces: reads.map((s) => s.sourceId),
    profile: compiled.profile,
  });
  // credentials is the redacted grant receipt. memberHandoff is the taken
  // private handoff, also stored only under memberClientSecretName.
  return { connectionId, credentials: r.json, memberHandoff, verify: verifyResult };
}

/**
 * Fresh-grant only. Take the member client's private handoff, keep the only
 * copy envelope-encrypted, and delete gbrain's delivery journal so the
 * plaintext file is not a second copy.
 */
async function storeMemberClientHandoff(
  organizationId: string,
  connectionId: string,
  clientId: string,
  credentialsOut: string,
): Promise<unknown> {
  const handoff = await takeGrantCredentials(credentialsOut);
  if (!handoff || typeof handoff !== 'object' || !('client_secret' in handoff)
    || typeof handoff.client_secret !== 'string' || handoff.client_secret.length === 0) {
    throw new Error('member client handoff carried no client_secret');
  }
  await storeSecret(organizationId, memberClientSecretName(connectionId), JSON.stringify(handoff));
  await deleteCredentialJournal(clientId);
  return handoff;
}

/**
 * D8: mint the Connection's server-side client and put its secret where secrets
 * live. The grant's own private journal is deleted here — the envelope-encrypted
 * copy in `secrets` is the only one we keep (F7: revocation never removes the
 * journal, and a plaintext credential that outlives its purpose is a leak).
 */
async function provisionServerClient(
  connectionId: string,
  organizationId: string,
  memberClientName: string,
  harness: string,
  compiled: CompiledConnection,
): Promise<string> {
  const name = serverClientName(memberClientName);
  const credentialsOut = serverCredentialsOutPath(connectionId);
  const r = await callOps(
    'mcp.grant',
    grantParams(name, harness, compiled, credentialsOut),
    { json: true },
  );
  if (!r.ok) throw new Error(`mcp.grant (server client) failed (exit ${r.exitCode}): ${String(r.stderr ?? '').slice(0, 500)}`);
  const clientId = grantedClientId(r.json);

  try {
    await applySurface(clientId, compiled);
  } catch (e) {
    try {
      await callOps('auth.revokeClient', { clientId });
    } catch {
      // Best-effort; the caller revokes the member client and rethrows.
    }
    throw e;
  }

  const handoff = await takeGrantCredentials(credentialsOut);
  if (!handoff || typeof handoff !== 'object' || !('client_secret' in handoff)
    || typeof handoff.client_secret !== 'string' || handoff.client_secret.length === 0) {
    throw new Error('server client handoff carried no client_secret');
  }
  // S3b: envelope-encrypted at rest, under the same name every reader would use.
  await storeSecret(organizationId, serverClientSecretName(connectionId), JSON.stringify(handoff));
  await deleteCredentialJournal(clientId);
  return clientId;
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
    // F7: the grant's private journal survives the revoke; it is now the last
    // copy of a dead secret, so delete it (and the server client's, below).
    await deleteCredentialJournal(row.gbrainClientId);
  }

  if (row.serverClientId) {
    // D8: both clients die with the Connection. A failure here is thrown, not
    // swallowed: the row is not yet marked revoked, so the operator sees a
    // half-revoked Connection instead of a silent one-client survivor.
    const r = await callOps('auth.revokeClient', { clientId: row.serverClientId });
    if (!r.ok) throw new Error(`auth.revokeClient (server client) failed (exit ${r.exitCode})`);
    await deleteCredentialJournal(row.serverClientId);
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

  // Honesty rule 3: scope removals are immediate. Disable, never delete — the
  // operator's schedule configuration survives so a re-grant can re-enable it.
  // Runs last on purpose: if the ops revoke above failed, nothing is disabled
  // and no alert is raised, so the alert can never describe a non-revocation.
  const disabled = await getDb().update(schema.schedules)
    .set({ enabled: false, disabledReason: 'connection_revoked' })
    .where(and(
      eq(schema.schedules.connectionId, connectionId),
      eq(schema.schedules.enabled, true),
    ))
    .returning({ id: schema.schedules.id });

  if (disabled.length > 0) {
    await getDb().insert(schema.scheduleAlerts).values(disabled.map((s) => ({
      id: randomUUID(), organizationId: row.organizationId, scheduleId: s.id, runId: null,
      kind: 'connection_revoked',
      detail: { connectionId, clientName: row.clientName },
    })));
  }
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
      serverClientId: null,
      provisionedAt: null,
      revokedAt: null,
    })
    .where(eq(schema.connections.id, connectionId));
}

function compileFrom(input: ConnectionInput, write: SpaceRow, reads: SpaceRow[]): CompiledConnection {
  const tokenTtl = input.tokenTtl
    ?? (connectionClass(input.harness) === 'manual' ? MANUAL_HARNESS_TOKEN_TTL : undefined);
  return compileConnection(
    { role: input.memberRole },
    { sourceId: write.sourceId, slug: write.sourceId },
    reads.map((s) => ({ sourceId: s.sourceId })),
    {
      boundSlugPrefixes: input.boundSlugPrefixes,
      tokenTtl,
      budgetUsdPerDay: input.budgetUsdPerDay,
      privateSpace: write.ownerMembershipId != null,
    },
  );
}

async function compileStored(
  row: ConnectionRow,
  role: Role,
  tokenTtl?: number,
): Promise<CompiledConnection> {
  const readIds = asStringArray(row.readSpaceIds);
  const { write, reads } = await loadSpaces(row.organizationId, row.writeSpaceId, readIds);
  const prefixes = Array.isArray(row.boundSlugPrefixes) ? row.boundSlugPrefixes as string[] : undefined;
  return compileConnection(
    { role },
    { sourceId: write.sourceId, slug: write.sourceId },
    reads.map((s) => ({ sourceId: s.sourceId })),
    {
      boundSlugPrefixes: prefixes,
      tokenTtl: tokenTtl ?? row.tokenTtl,
      budgetUsdPerDay: row.budgetUsdPerDay != null ? Number(row.budgetUsdPerDay) : undefined,
      privateSpace: write.ownerMembershipId != null,
    },
  );
}

/**
 * The inverse of compile.ts's `ROLE_TO_PROFILE`, for the one caller that must
 * compile WITHOUT a role: the run lane. The connection row stores the compiled
 * profile — the scope the member's own client carries — and reading the member's
 * current role instead would silently re-scope a run whenever that role changed
 * after the grant. Only the three profiles a Connection can actually hold are
 * listed; `operator`, `delegating-agent` and `full` are not reachable from
 * `compileConnection`, so a row carrying one is a loud error, not a guess.
 */
const PROFILE_TO_ROLE: Partial<Record<GrantProfileId, Role>> = {
  'memory-reader': 'viewer',
  'memory-writer': 'member',
  'coding-agent': 'admin',
};

/** The row stores `profile` as text; this narrows it to the known ids. */
function isGrantProfileId(value: string): value is GrantProfileId {
  return (GRANT_PROFILES as readonly string[]).includes(value);
}

/**
 * D8 (Task 5): the compiled scoping one RUN's gbrain client gets. The
 * Connection's stored scoping verbatim — same write Space, same federated read,
 * same fence, same profile, through `compileStored`, so there is no second
 * compiler — with the RUN's TTL instead of the member's. `compileConnection`
 * clamps it to gbrain's own 60..7_776_000 grant bounds.
 *
 * A Connection that is not `active` has no business minting a brain credential,
 * so this refuses rather than relying on the caller's precondition.
 */
export async function runScopeFor(connectionId: string, ttlSeconds: number): Promise<{
  organizationId: string;
  membershipId: string;
  harness: string;
  name: string;
  compiled: CompiledConnection;
}> {
  const row = await loadConnection(connectionId);
  if (row.state !== 'active') throw new Error(`connection ${connectionId} is not active`);
  const role = isGrantProfileId(row.profile) ? PROFILE_TO_ROLE[row.profile] : undefined;
  if (!role) throw new Error(`connection ${connectionId} has profile ${row.profile}, which no role compiles to`);
  return {
    organizationId: row.organizationId,
    membershipId: row.membershipId,
    harness: row.harness,
    name: row.clientName,
    compiled: await compileStored(row, role, ttlSeconds),
  };
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

/** One argv builder for every `mcp.grant` call (member, server, per-run). */
export function grantParams(
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

/**
 * `mcp grant` takes no --surface, so a fresh client comes out at its
 * profile's default (`starter`). Apply the compiled surface right after the
 * mint. MEASURED: the full re-statement is rejected (`read_source_inactive`);
 * `{ id, surface }` alone works and leaves the mint-time scoping intact, so
 * D8 holds (both clients were compiled identically at mint). See
 * docs/member-skills-findings.md.
 */
async function applySurface(clientId: string, compiled: CompiledConnection): Promise<void> {
  const r = await callOps('auth.rescopeClient', { id: clientId, surface: compiled.surface }, { json: true });
  if (!r.ok) throw new Error(`auth.rescopeClient (surface) failed (exit ${r.exitCode})`);
}

export function mcpUrl(): string {
  const base = (process.env.PUBLIC_URL ?? 'http://127.0.0.1:3131').replace(/\/+$/, '');
  return base.endsWith('/mcp') ? base : `${base}/mcp`;
}

/** The client id in an `mcp.grant` receipt (pin shape; L6/L7 parsers). */
export function grantedClientId(json: unknown): string {
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
  extra: {
    gbrainClientId?: string; serverClientId?: string; state?: string; provisionedAt?: Date;
    verifyStatus?: 'ok' | 'partial' | 'failed' | null; verifiedAt?: Date | null; verifyMessage?: string | null;
  } = {},
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
      serverClientId: row.serverClientId,
      clientName: row.clientName,
      writeSpace: write.sourceId,
      readSpaces: reads.map((s) => s.sourceId),
      profile: row.profile,
    };
  } catch {
    return {
      clientId: row.gbrainClientId,
      serverClientId: row.serverClientId,
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

/**
 * One-shot backfill: Connections minted before member skills sit at
 * `starter`. Re-derive each active Connection's compiled scoping and rescope
 * both clients (server first, D8). Per-row failures are collected, not
 * thrown, so one dead client never blocks the rest.
 */
export async function widenConnectionSurfaces(actor: string): Promise<{
  widened: string[];
  failed: Array<{ connectionId: string; error: string }>;
}> {
  const rows = await getDb().select().from(schema.connections)
    .where(eq(schema.connections.state, 'active'));
  const widened: string[] = [];
  const failed: Array<{ connectionId: string; error: string }> = [];
  for (const row of rows) {
    try {
      if (!row.gbrainClientId) throw new Error('active Connection has no gbrainClientId');
      const role = isGrantProfileId(row.profile) ? PROFILE_TO_ROLE[row.profile] : undefined;
      if (!role) throw new Error(`connection ${row.id} has profile ${row.profile}, which no role compiles to`);
      const compiled = await compileStored(row, role);
      if (row.serverClientId) await applySurface(row.serverClientId, compiled);
      await applySurface(row.gbrainClientId, compiled);
      await audit(row.organizationId, actor, 'connection.widen_surface', row.id, {
        surface: compiled.surface, clientId: row.gbrainClientId, serverClientId: row.serverClientId,
      });
      widened.push(row.id);
    } catch (e) {
      failed.push({ connectionId: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { widened, failed };
}
