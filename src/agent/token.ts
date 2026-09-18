/**
 * D8 — the per-run gbrain token lane (Task 5).
 *
 * Which arm, and why. The preferred arm was: ONE long-lived server-side client
 * per Connection, a fresh access token minted from it per run over OAuth
 * `POST /token`, killed individually with RFC 7009 `POST /revoke`. Task 5's
 * Step 0 probe measured that mechanism working end to end (fresh token for an
 * existing client; `/revoke` 200; that token 401 while the client's other token
 * stayed 200; mint again succeeds) — so the mechanism is available. The arm
 * taken is still the fallback, because the mechanism's REVOKE cannot run from
 * the two places that must run it:
 *
 *   - Revoking one OAuth token needs the raw token, and neither caller holds it.
 *     The runner does; the finish route and `reclaimExpiredLeases` do not, so the
 *     raw run bearer would have to sit in the control DB. Reading it back needs
 *     ENCRYPTION_KEY, which the scheduler does not have — and giving it one would
 *     hand the scheduler the ability to decrypt every org secret, including the
 *     provider API key that S3b says only the gateway reads.
 *   - Neither the control plane nor the scheduler has a route to gbrain-serve
 *     (compose networks: control-plane [control-net, ops-net, runner-net],
 *     scheduler [control-net, ops-net]; gbrain-serve is brain-net only, and this
 *     stack's PUBLIC_URL is https://localhost, which inside a container is that
 *     container's own loopback). Only gbrain-ops is on brain-net, and its
 *     allowlist has no OAuth verb.
 *
 * The fallback crosses the door both callers already hold (the ops RPC) and uses
 * published operations only (`mcp.grant`, `take-grant-credentials`,
 * `auth.revoke-client`): mint a run-scoped client with the Connection's own
 * compiled scoping, take the access token that grant minted, and kill the whole
 * client at the end. Per-run precision is the same — the client IS the run's
 * identity — and it costs one `/token` hit per run (the grant's own
 * client-credentials exchange), not two.
 *
 * Both calls are idempotent because the finish path and the reclaim path can
 * race on the same run (honesty rule 9).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '../control/db/client.ts';
import { callOps, deleteCredentialJournal, takeGrantCredentials } from '../control/opsClient.ts';
import { grantParams, grantedClientId, runCredentialsOutPath, runScopeFor } from '../control/connections.ts';

export type MintedRunToken = {
  /** The run's own gbrain OAuth client. Non-secret — it is what
   *  `agent_runs.gbrain_client_id` stores and what the reclaimer revokes. */
  gbrainClientId: string;
  /** The bearer the harness sends to gbrain's `/mcp`. Handed to the runner; we
   *  deliberately keep no copy, because revocation here is by client id. */
  accessToken: string;
};

/**
 * Mint one run's gbrain credential (Task 5, fallback arm). `ttlSeconds` is the
 * run's own deadline and becomes the client's token TTL, so the credential
 * expires when the run should already have been reaped — defence in depth, never
 * the mechanism.
 *
 * A failure after the client exists revokes it, so a failed mint cannot leave a
 * live brain credential behind.
 */
export async function mintRunToken(connectionId: string, ttlSeconds: number): Promise<MintedRunToken> {
  const scope = await runScopeFor(connectionId, ttlSeconds);
  const tag = randomUUID().replace(/-/g, '').slice(0, 12);
  const name = `bs-run-${connectionId.slice(0, 8)}-${tag}`;
  const credentialsOut = runCredentialsOutPath(tag);

  const r = await callOps('mcp.grant', grantParams(name, scope.harness, scope.compiled, credentialsOut), {
    json: true,
  });
  if (!r.ok) throw new Error(`mcp.grant (run token) failed (exit ${r.exitCode})`);
  const gbrainClientId = grantedClientId(r.json);

  try {
    const handoff = await takeGrantCredentials(credentialsOut);
    const accessToken = readAccessToken(handoff);
    return { gbrainClientId, accessToken };
  } catch (e) {
    // Never leave the credential we could not deliver: the handoff file may
    // still be on the ops side (claim did not take it), so kill the client and
    // its journal, then surface the failure.
    try {
      await killRunClient(gbrainClientId);
    } catch {
      // Ops may be down; the caller's error below is the operator's signal.
    }
    throw e;
  }
}

/**
 * Kill one run's gbrain credential and stamp the run (Task 5, honesty rule 9).
 *
 * Called from the finish path AND from `reclaimExpiredLeases`, so it races with
 * itself. The first caller to claim the row's `token_revoked_at` performs the
 * revoke; a later caller is a no-op that leaves the stamp in place. That claim
 * is what keeps `auth revoke-client` from being called twice — a second call for
 * a deleted client exits 1 ("No client found with id", measured) and would fail
 * the other caller's real work.
 *
 * Returns `{ revoked: true }` only for the caller that actually killed the
 * credential.
 */
export async function revokeRunToken(runId: string): Promise<{ revoked: boolean }> {
  const claimed = await getDb()
    .update(schema.agentRuns)
    .set({ tokenRevokedAt: new Date() })
    .where(and(eq(schema.agentRuns.runId, runId), isNull(schema.agentRuns.tokenRevokedAt)))
    .returning({ gbrainClientId: schema.agentRuns.gbrainClientId });

  if (claimed.length === 0) {
    // Already revoked (another caller won the race, or an earlier finish did) —
    // or a run id that does not exist, which is a caller bug and must not look
    // like a successful no-op.
    const [row] = await getDb()
      .select({ runId: schema.agentRuns.runId })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.runId, runId));
    if (!row) throw new Error(`agent run ${runId} not found`);
    // The stamp is the authority and it is already set; re-issue it so the
    // documented idempotency holds even if this call raced the very first write.
    await getDb()
      .update(schema.agentRuns)
      .set({ tokenRevokedAt: new Date() })
      .where(eq(schema.agentRuns.runId, runId));
    return { revoked: false };
  }

  const clientId = claimed[0]?.gbrainClientId;
  if (clientId) {
    try {
      await killRunClient(clientId);
    } catch (e) {
      // Release the claim: a stamped row would otherwise veto the retry, and a
      // credential nobody will revoke is worse than a visible error. Residual,
      // stated rather than hidden: a caller that raced this failing winner has
      // already returned `{revoked:false}`; the minted TTL and
      // `revokeConnection` (which kills the client regardless) are the backstops.
      await getDb()
        .update(schema.agentRuns)
        .set({ tokenRevokedAt: null })
        .where(eq(schema.agentRuns.runId, runId));
      throw e;
    }
  }
  return { revoked: true };
}

/**
 * The kill switch: `auth revoke-client` cascades to the client's tokens and
 * authorization codes, and works whether or not the runner still exists. The
 * grant's retained journal is deleted with it (F7) — revoking the client alone
 * leaves that plaintext secret on the file plane.
 */
async function killRunClient(clientId: string): Promise<void> {
  const r = await callOps('auth.revokeClient', { clientId });
  if (!r.ok) throw new Error(`auth.revokeClient failed (exit ${r.exitCode})`);
  await deleteCredentialJournal(clientId);
}

/** The bearer out of a grant's private handoff. A malformed handoff is a
 *  failure, never a token-shaped `undefined` the harness would send. */
function readAccessToken(handoff: unknown): string {
  if (handoff && typeof handoff === 'object' && 'access_token' in handoff
    && typeof handoff.access_token === 'string' && handoff.access_token.length > 0) {
    return handoff.access_token;
  }
  throw new Error('run token handoff carried no access_token');
}
