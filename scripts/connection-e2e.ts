#!/usr/bin/env bun
/**
 * Seam Gate A — the money path, headless.
 *
 * Extends scripts/tutorial.ts:189-265 (grant → init.mcpOnly into a per-member
 * GBRAIN_HOME → whoami → scoped search) with the compiler pairing, a real
 * revoke, an audit-before-delete proof, and doctor. No UI, no HTTP, no console.
 *
 * Isolation is the same property the tutorial exists to prove: a thin-client
 * search is scoped to THAT OAuth grant, not gbrain-ops's local-admin view.
 * Both halves are required — absence-of-leak alone passes if everyone sees
 * nothing; the positive half requires a member who can read `internal` to
 * actually see it.
 */
import { randomUUID } from 'node:crypto';
import { execOperation } from '../src/contracts/exec.ts';
import { OPERATIONS } from '../src/contracts/registry.ts';
import { compileConnection, clientName, type CompiledConnection } from '../src/contracts/compile.ts';
import { composeExec } from '../src/docker/host.ts';
import { resetBrain, seedGitSource, BRAIN_DB_URL } from '../test/helpers/stack.ts';
import type { ParamValues } from '../src/contracts/types.ts';

const COMPOSE_FILE = 'compose/docker-compose.slice0.yml';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'openai:text-embedding-3-small';

const MCP_BIND = '127.0.0.1';
const MCP_PORT = 3131;
const MCP_URL = `http://${MCP_BIND}:${MCP_PORT}/mcp`;
const ISSUER_URL = `http://${MCP_BIND}:${MCP_PORT}`;

/** Integration-test control DB (bs-fp-pg). Slice0 postgres publishes no host port. */
const CONTROL_DATABASE_URL =
  process.env.CONTROL_DATABASE_URL ?? 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

export type GateStep = { id: string; ok: boolean; exitCode: number; ms: number };
export type ConnectionE2EReport = {
  steps: GateStep[];
  doctorExitCode: number;
  pairingOk: boolean;
  whoamiOk: boolean;
  isolationOk: boolean;
  revokeOk: boolean;
  auditOk: boolean;
};

const SOURCES = [
  { id: 'shared', name: 'Shared company wiki', file: 'widget-launch.md',
    printfBody: '# Widget launch plan\\n\\nShip the widget in March.\\n' },
  { id: 'customers', name: 'Customer notes', file: 'acme-notes.md',
    printfBody: '# Customer notes\\n\\nAcme wants faster onboarding.\\n' },
  { id: 'internal', name: 'Internal-only', file: 'performance-review.md',
    printfBody: '# Performance review process\\n\\nAnnual cycle runs in Q4.\\n' },
] as const;

/** Tutorial probe: internal page title. Hybrid search may also recall other
 *  granted sources; isolation asserts source_id membership, not hit count. */
const PROBE_QUERY = 'performance review';

const PAIRING = {
  id: 'gate-a-reader',
  membershipId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  role: 'member' as const,
  write: { sourceId: 'customers', slug: 'customers' },
  reads: [{ sourceId: 'customers' }, { sourceId: 'shared' }, { sourceId: 'internal' }],
};

/** Disjoint from internal so the negative half can actually go red. */
const ISOLATED = {
  id: 'gate-a-isolated',
  membershipId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  role: 'member' as const,
  write: { sourceId: 'customers', slug: 'customers' },
  reads: [{ sourceId: 'customers' }, { sourceId: 'shared' }],
};

function memberHome(id: string): string {
  return `/srv/gbrain-home/member-${id}`;
}

function startServe() {
  return Bun.spawn(
    ['docker', 'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'gbrain-ops',
      'gbrain', 'serve', '--http', '--bind', MCP_BIND, '--port', String(MCP_PORT)],
    { stdout: 'pipe', stderr: 'pipe' },
  );
}

async function waitForServe(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const probe = await composeExec('gbrain-ops', [
      'bun', '-e',
      `const r = await fetch(${JSON.stringify(`${ISSUER_URL}/.well-known/gbrain`)}).catch(() => null); ` +
      'if (r && r.ok) console.log("ready");',
    ]);
    if (probe.stdout.includes('ready')) return;
    await Bun.sleep(1000);
  }
  throw new Error(`gbrain serve did not become ready at ${ISSUER_URL} within 60s`);
}

async function stopServe(local: ReturnType<typeof startServe>): Promise<void> {
  local.kill();
  await composeExec('gbrain-ops', [
    'bun', '-e',
    "const fs=require('fs'); for (const pid of fs.readdirSync('/proc')) { " +
    "if (!/^[0-9]+$/.test(pid) || Number(pid) === process.pid) continue; " +
    "try { const cmd = fs.readFileSync('/proc/'+pid+'/cmdline','utf8'); " +
    "if (cmd.indexOf('gbrain') >= 0 && cmd.indexOf('serve') >= 0) process.kill(Number(pid), 'SIGTERM'); " +
    "} catch (e) {} }",
  ]);
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(actual)) return false;
  const left = actual.map(String).sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((x, i) => x === right[i]);
}

function grantMatchesCompiled(grant: Record<string, unknown> | null, compiled: CompiledConnection): string[] {
  const mismatches: string[] = [];
  if (!grant) return ['grant missing from dry-run JSON'];
  if (grant.profile !== compiled.profile) {
    mismatches.push(`profile: grant=${JSON.stringify(grant.profile)} compiled=${compiled.profile}`);
  }
  if (grant.sourceId !== compiled.sourceId) {
    mismatches.push(`sourceId: grant=${JSON.stringify(grant.sourceId)} compiled=${compiled.sourceId}`);
  }
  if (!sameStrings(grant.federatedRead, compiled.federatedRead)) {
    mismatches.push(`federatedRead: grant=${JSON.stringify(grant.federatedRead)} compiled=${JSON.stringify(compiled.federatedRead)}`);
  }
  const ttl = grant.tokenTtlSeconds ?? grant.tokenTtl;
  if (ttl !== compiled.tokenTtl) {
    mismatches.push(`tokenTtl: grant=${JSON.stringify(ttl)} compiled=${compiled.tokenTtl}`);
  }
  return mismatches;
}

function searchHits(json: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(json)) return json as Array<Record<string, unknown>>;
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    for (const k of ['results', 'hits', 'items']) {
      if (Array.isArray(o[k])) return o[k] as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function hitSourceIds(hits: Array<Record<string, unknown>>): string[] {
  return hits
    .map((r) => (r.source_id ?? r.sourceId) as string | undefined)
    .filter((sid): sid is string => typeof sid === 'string' && sid.length > 0);
}

function grantParams(name: string, compiled: CompiledConnection, credentialsOut?: string): ParamValues {
  const params: ParamValues = {
    name,
    harness: 'generic',
    profile: compiled.profile,
    source: compiled.sourceId,
    federatedRead: [...compiled.federatedRead],
    url: MCP_URL,
    tokenTtl: String(compiled.tokenTtl),
  };
  if (credentialsOut) params.credentialsOut = credentialsOut;
  return params;
}

/**
 * Slice0 has no control DB and no ops RPC. T5's audit_log lives on the
 * control plane (bs-fp-pg). Seed a real connection row, let revokeConnection
 * write the audit row first, then prove the thin-client token dies via
 * auth.revokeClient in gbrain-ops. Never point OPS_RPC_URL at production :3140.
 */
async function auditThenOpsRevoke(clientId: string, compiled: CompiledConnection, actor: string): Promise<{
  auditBeforeDelete: boolean;
  connectionId: string;
}> {
  const priorOpsUrl = process.env.OPS_RPC_URL;
  process.env.CONTROL_DATABASE_URL = CONTROL_DATABASE_URL;
  process.env.OPS_RPC_URL = 'http://127.0.0.1:1';
  try {
    const { runMigrations, getDb, schema, closeDb } = await import('../src/control/db/client.ts');
    const { revokeConnection } = await import('../src/control/connections.ts');
    const { eq } = await import('drizzle-orm');

    await runMigrations();
    const db = getDb();
    const orgId = randomUUID();
    const userId = actor;
    const membershipId = randomUUID();
    const writeId = randomUUID();
    const sharedId = randomUUID();
    const internalId = randomUUID();
    const connectionId = randomUUID();

    await db.insert(schema.users).values({
      id: userId, email: `gate-a-${connectionId}@example.test`, emailVerified: false,
    });
    await db.insert(schema.organizations).values({
      id: orgId, name: `GateA ${connectionId.slice(0, 8)}`, slug: `gate-a-${connectionId.slice(0, 8)}`,
    });
    await db.insert(schema.memberships).values({
      id: membershipId, userId, organizationId: orgId, role: 'member',
    });
    await db.insert(schema.spaces).values([
      { id: writeId, organizationId: orgId, sourceId: 'customers', name: 'Customers', kind: 'local-git' },
      { id: sharedId, organizationId: orgId, sourceId: 'shared', name: 'Shared', kind: 'local-git' },
      { id: internalId, organizationId: orgId, sourceId: 'internal', name: 'Internal', kind: 'local-git' },
    ]);
    await db.insert(schema.connections).values({
      id: connectionId,
      organizationId: orgId,
      membershipId,
      writeSpaceId: writeId,
      readSpaceIds: [writeId, sharedId, internalId],
      harness: 'generic',
      clientName: clientName(membershipId, compiled.sourceId),
      gbrainClientId: clientId,
      profile: compiled.profile,
      tokenTtl: compiled.tokenTtl,
      state: 'active',
      provisionedAt: new Date(),
    });

    try {
      await revokeConnection(connectionId, userId);
    } catch {
      // Expected: callOps cannot reach slice0 (no ops RPC). Audit must already exist.
    }

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'connection.revoke'));
    const audit = audits.find((row) => row.target === connectionId);
    const auditBeforeDelete = Boolean(audit) && !JSON.stringify(audit).includes('client_secret');

    await closeDb();
    return { auditBeforeDelete, connectionId };
  } finally {
    // A sibling contract file shares this `bun test` process. Leaving the
    // unreachable :1 behind would answer every later file's ops call with
    // ConnectionRefused (measured: test/contract/usage.contract.test.ts).
    if (priorOpsUrl === undefined) delete process.env.OPS_RPC_URL;
    else process.env.OPS_RPC_URL = priorOpsUrl;
  }
}

export async function runConnectionE2E(): Promise<ConnectionE2EReport> {
  const steps: GateStep[] = [];
  let pairingOk = false;
  let whoamiOk = false;
  let isolationOk = true;
  let revokeOk = false;
  let auditOk = false;

  async function step(
    id: string,
    opId: string,
    values: ParamValues,
    opts: { json?: boolean; dryRun?: boolean; timeoutMs?: number; env?: Record<string, string> } = {},
  ) {
    const spec = OPERATIONS[opId];
    if (!spec) throw new Error(`unregistered operation ${opId} — add it to the registry with a contract test`);
    const t0 = Date.now();
    const r = await execOperation(spec, values, {
      json: opts.json, dryRun: opts.dryRun, timeoutMs: opts.timeoutMs, env: opts.env,
    });
    const ok = spec.okExitCodes.includes(r.exitCode);
    steps.push({ id, ok, exitCode: r.exitCode, ms: Date.now() - t0 });
    if (!ok) console.error(`[${id}] exit ${r.exitCode}\n${r.stderr}`);
    return r;
  }

  await resetBrain();

  await step('init', 'init', {
    nonInteractive: true, force: true, url: BRAIN_DB_URL, embeddingModel: EMBEDDING_MODEL,
  }, { timeoutMs: 900_000 });
  await step('config:search-mode', 'config.set', { key: 'search.mode', value: 'conservative' });

  for (const s of SOURCES) {
    await seedGitSource(s.id);
    const dir = `/srv/brain-repos/${s.id}`;
    const extra = await composeExec('gbrain-ops', ['sh', '-c',
      `set -e; cd ${dir}; ` +
      `git config user.email mobrain@example.invalid; git config user.name mobrain; ` +
      `printf '${s.printfBody}' > ${s.file}; git add -A; ` +
      `git diff --cached --quiet || git commit -qm 'probe ${s.id}'`]);
    steps.push({ id: `seed:${s.id}`, ok: extra.exitCode === 0, exitCode: extra.exitCode, ms: 0 });
    await step(`sources:add:${s.id}`, 'sources.add', { id: s.id, path: dir, name: s.name });
  }

  await step('sync:all', 'sync', { all: true }, { json: true, timeoutMs: 900_000 });
  const embed = await step('embed:stale', 'embed', { stale: true }, { json: true, timeoutMs: 900_000 });
  if (!OPERATIONS.embed!.okExitCodes.includes(embed.exitCode)) {
    console.error('[embed] failed; falling back to keyword search for isolation');
  }

  const pairingCompiled = compileConnection(
    { role: PAIRING.role }, PAIRING.write, PAIRING.reads,
  );
  const isolatedCompiled = compileConnection(
    { role: ISOLATED.role }, ISOLATED.write, ISOLATED.reads,
  );
  if (!pairingCompiled.federatedRead.includes('internal')) {
    throw new Error('pairing compile must include internal in federatedRead');
  }

  const pairingName = clientName(PAIRING.membershipId, PAIRING.write.slug);
  const isolatedName = clientName(ISOLATED.membershipId, ISOLATED.write.slug);

  const preview = await step('grant:dry-run', 'mcp.grant', grantParams(pairingName, pairingCompiled), {
    json: true, dryRun: true,
  });
  const previewBody = preview.json as { status?: string; grant?: Record<string, unknown> } | null;
  const mismatches = grantMatchesCompiled(previewBody?.grant ?? null, pairingCompiled);
  pairingOk = preview.exitCode === 0 && previewBody?.status === 'preview' && mismatches.length === 0;
  steps.push({ id: 'compiler-pairing', ok: pairingOk, exitCode: pairingOk ? 0 : 1, ms: 0 });
  console.log(`[pairing] status=${previewBody?.status} compiled=${JSON.stringify({
    profile: pairingCompiled.profile,
    sourceId: pairingCompiled.sourceId,
    federatedRead: pairingCompiled.federatedRead,
    tokenTtl: pairingCompiled.tokenTtl,
  })} grant=${JSON.stringify({
    profile: previewBody?.grant?.profile,
    sourceId: previewBody?.grant?.sourceId,
    federatedRead: previewBody?.grant?.federatedRead,
    tokenTtlSeconds: previewBody?.grant?.tokenTtlSeconds,
  })}`);
  if (!pairingOk) {
    console.error(`[pairing] dry-run grant did not match compiled: status=${previewBody?.status} mismatches=${mismatches.join('; ')}`);
  }

  const serve = startServe();
  try {
    await waitForServe();

    const pairingCredsFile = `/srv/gbrain-home/.creds-${PAIRING.id}.json`;
    const isolatedCredsFile = `/srv/gbrain-home/.creds-${ISOLATED.id}.json`;

    await step(`grant:${PAIRING.id}`, 'mcp.grant', grantParams(pairingName, pairingCompiled, pairingCredsFile), { json: true });
    await step(`grant:${ISOLATED.id}`, 'mcp.grant', grantParams(isolatedName, isolatedCompiled, isolatedCredsFile), { json: true });

    const creds: Record<string, { clientId: string; clientSecret: string }> = {};
    for (const [id, file] of [[PAIRING.id, pairingCredsFile], [ISOLATED.id, isolatedCredsFile]] as const) {
      const cat = await composeExec('gbrain-ops', ['cat', file]);
      if (cat.exitCode !== 0) throw new Error(`could not read the credential handoff for ${id}: ${cat.stderr}`);
      const parsed = JSON.parse(cat.stdout) as { client_id: string; client_secret: string };
      creds[id] = { clientId: parsed.client_id, clientSecret: parsed.client_secret };
    }

    const members: Array<{ id: string; compiled: CompiledConnection }> = [
      { id: PAIRING.id, compiled: pairingCompiled },
      { id: ISOLATED.id, compiled: isolatedCompiled },
    ];

    for (const m of members) {
      const env = { GBRAIN_HOME: memberHome(m.id) };
      const c = creds[m.id]!;

      await step(`mcp-only-init:${m.id}`, 'init.mcpOnly', {
        issuerUrl: ISSUER_URL, mcpUrl: MCP_URL,
        oauthClientId: c.clientId, oauthClientSecret: c.clientSecret,
      }, { json: true, env });

      const who = await step(`whoami:${m.id}`, 'whoami', {}, { json: true, env });
      const whoBody = who.json as { transport?: string; source_id?: string; federated_read?: string[] } | null;
      const thisWhoOk = Boolean(
        whoBody
        && whoBody.transport === 'oauth'
        && whoBody.source_id === m.compiled.sourceId
        && sameStrings(whoBody.federated_read, m.compiled.federatedRead),
      );
      steps.push({ id: `whoami-scope:${m.id}`, ok: thisWhoOk, exitCode: who.exitCode, ms: 0 });
      if (m.id === PAIRING.id) whoamiOk = thisWhoOk;
      console.log(`[whoami] ${m.id} ${JSON.stringify({
        transport: whoBody?.transport,
        source_id: whoBody?.source_id,
        federated_read: whoBody?.federated_read,
      })}`);
      if (!thisWhoOk) {
        isolationOk = false;
        console.error(`[whoami] ${m.id} unexpected identity: ${JSON.stringify(whoBody)}`);
      }

      const probe = await step(`search:${m.id}`, 'search', { query: PROBE_QUERY }, { json: true, env });
      const seenSourceIds = hitSourceIds(searchHits(probe.json));
      console.log(`[search] ${m.id} query=${JSON.stringify(PROBE_QUERY)} sources=${JSON.stringify(seenSourceIds)} hits=${seenSourceIds.length}`);
      const allowed = new Set<string>([m.compiled.sourceId, ...m.compiled.federatedRead]);
      const leaked = seenSourceIds.filter((sid) => !allowed.has(sid));
      const canReadInternal = allowed.has('internal');
      const positiveProofOk = !canReadInternal || seenSourceIds.includes('internal');
      const negativeProofOk = leaked.length === 0 && (!canReadInternal ? !seenSourceIds.includes('internal') : true);
      const scopedOk = negativeProofOk && positiveProofOk;
      steps.push({ id: `isolation:${m.id}`, ok: scopedOk, exitCode: 0, ms: 0 });
      if (leaked.length > 0) {
        isolationOk = false;
        console.error(`[isolation] ${m.id} saw results from ${[...new Set(leaked)].join(',')}`);
      }
      if (!positiveProofOk) {
        isolationOk = false;
        console.error(`[isolation] ${m.id} can read 'internal' but the probe query returned no internal hit`);
      }
      if (canReadInternal === false && seenSourceIds.includes('internal')) {
        isolationOk = false;
        console.error(`[isolation] ${m.id} must not see 'internal'`);
      }
    }

    const pairingEnv = { GBRAIN_HOME: memberHome(PAIRING.id) };
    const pairingClientId = creds[PAIRING.id]!.clientId;
    const audit = await auditThenOpsRevoke(pairingClientId, pairingCompiled, randomUUID());
    auditOk = audit.auditBeforeDelete;
    steps.push({ id: 'audit-before-delete', ok: auditOk, exitCode: auditOk ? 0 : 1, ms: 0 });
    console.log(`[audit] before-delete=${auditOk} connectionId=${audit.connectionId}`);
    if (!auditOk) console.error('[audit] connection.revoke row was not written before ops revoke');

    const revoked = await step('revoke', 'auth.revokeClient', { clientId: pairingClientId });
    const searchAfter = await execOperation(OPERATIONS.search!, { query: PROBE_QUERY }, {
      json: true, env: pairingEnv, timeoutMs: 60_000,
    });
    const searchFailed = !OPERATIONS.search!.okExitCodes.includes(searchAfter.exitCode);
    revokeOk = revoked.exitCode === 0 && searchFailed;
    steps.push({ id: 'revoke-search-fails', ok: revokeOk, exitCode: searchAfter.exitCode, ms: 0 });
    console.log(`[revoke] auth.revokeClient exit ${revoked.exitCode}; search-after exit ${searchAfter.exitCode}`);
    if (!revokeOk) {
      console.error(`[revoke] client still searchable after revoke (exit ${searchAfter.exitCode})`);
    }
  } finally {
    await stopServe(serve);
  }

  const doctor = await execOperation(OPERATIONS.doctor!, {}, { json: true, timeoutMs: 900_000 });
  steps.push({ id: 'doctor', ok: doctor.exitCode === 0, exitCode: doctor.exitCode, ms: 0 });
  const doctorBody = doctor.json as { status?: string; health_score?: unknown } | null;
  console.log(`[doctor] exit ${doctor.exitCode} status=${doctorBody?.status ?? 'n/a'} health_score=${JSON.stringify(doctorBody?.health_score ?? null)}`);

  return {
    steps,
    doctorExitCode: doctor.exitCode,
    pairingOk,
    whoamiOk,
    isolationOk,
    revokeOk,
    auditOk,
  };
}

if (import.meta.main) {
  const report = await runConnectionE2E();
  console.log(JSON.stringify(report, null, 2));
  const failed = report.steps.filter((s) => !s.ok);
  if (
    failed.length > 0
    || report.doctorExitCode !== 0
    || !report.pairingOk
    || !report.whoamiOk
    || !report.isolationOk
    || !report.revokeOk
    || !report.auditOk
  ) process.exit(1);
}
