/**
 * D8 — read gbrain's OWN spend through its published `get_usage` operation.
 *
 * The hard rule: `chat_usage_log` is gbrain's table. We never read it (G2).
 * We mint a short-TTL `operator`-profile client ops-side through the registry's
 * `mcp.grant`, take its access token from the one-time private handoff, call
 * `get_usage` over the HTTP MCP data lane, map the receipt's snake_case to
 * camelCase WITHOUT altering a single value, carry the `coverage` block
 * verbatim (it is upstream's own list of what the ledger does NOT capture), and
 * revoke the client in a `finally`.
 *
 * Why `operator` and not `full`: upstream's `get_usage` carries scope `admin`
 * (src/core/ops/usage.ts); the `operator` profile grants exactly `['admin']`
 * (src/core/grants/profiles.ts), and its `allowedOperations` snapshot includes
 * `get_usage` — measured, not assumed (U2 in docs/slice-5-findings.md). `full`
 * would add `agent` scope this read has no business holding.
 *
 * Never log the token (S3c). Nothing here logs a body.
 */
import { randomUUID } from 'node:crypto';
import { callOps, deleteCredentialJournal, takeGrantCredentials } from '../control/opsClient.ts';
import { mcpEndpoint, parseMcpMessage, readToolText, tlsOption } from './mcpLane.ts';

export type BrainUsage = {
  windowDays: number;
  totals: { calls: number; inputTokens: number; outputTokens: number;
            cacheReadTokens: number; cacheWriteTokens: number; costUsd: number };
  byModel: { model: string; calls: number; costUsd: number | null; unpricedCalls: number }[];
  byPhase: { phase: string; calls: number; costUsd: number }[];
  /** Upstream's own words, carried VERBATIM. Never paraphrased (D8). */
  coverage: { source: string; loggedSince: string | null; tablePresent: boolean;
              pricedCalls: number; unpricedCalls: number; notCovered: string[] };
};

/** The grant's own TTL: minutes-scale, like Slice 4's per-run mint (D8). */
const GRANT_TTL_SECONDS = 300;

/**
 * The `--url` the `mcp.grant` carries. It is credential-delivery bookkeeping,
 * NOT the lane `get_usage` dials: with `credentialsOut` set, gbrain writes the
 * token to a file, and the MCP call is a separate fetch to `mcpEndpoint()`.
 *
 * gbrain validates this URL with `assertSecureEndpoint`/`normalizeMcpUrl` and
 * REFUSES a non-loopback plain-HTTP endpoint ("Use HTTPS for credential
 * delivery; HTTP is supported only on loopback"), so feeding it the internal
 * `http://gbrain-serve:3131/mcp` data lane made every stock-stack read throw
 * (F20). Every other grant in the product passes `mcpUrl()`
 * (`src/control/connections.ts`): PUBLIC_URL when one is configured, loopback
 * otherwise. This mirrors that convention — the ops container sets no
 * PUBLIC_URL, so it resolves to loopback and gbrain accepts it. Kept local
 * rather than imported because the control-plane DB module graph must not enter
 * the ops process (S2).
 */
function grantEndpoint(): string {
  const base = (process.env.PUBLIC_URL ?? 'http://127.0.0.1:3131').replace(/\/+$/, '');
  return base.endsWith('/mcp') ? base : `${base}/mcp`;
}

export async function readBrainUsage(days: number): Promise<BrainUsage> {
  const tag = randomUUID().replace(/-/g, '').slice(0, 12);
  const name = `bs-usage-${tag}`;
  const credentialsOut = `/srv/gbrain-home/.creds-usage-${tag}.json`;
  const endpoint = mcpEndpoint();
  const grantUrl = grantEndpoint();

  const r = await callOps('mcp.grant', {
    name,
    harness: 'generic',
    profile: 'operator',
    // Bookkeeping only: gbrain refuses the internal plain-HTTP data lane here.
    url: grantUrl,
    tokenTtl: String(GRANT_TTL_SECONDS),
    credentialsOut,
  }, { json: true });
  if (!r.ok) throw new Error(`mcp.grant (usage) failed (exit ${r.exitCode})`);
  const clientId = grantedClientId(r.json);

  try {
    const handoff = await takeGrantCredentials(credentialsOut);
    const accessToken = readAccessToken(handoff);
    const receipt = await callGetUsage(endpoint, accessToken, days);
    return mapUsage(receipt);
  } finally {
    // Never leave the admin client live, whatever happened above.
    try {
      await callOps('auth.revokeClient', { clientId });
    } catch {
      // Best-effort: the minted TTL is the backstop. Revoking must not mask
      // the caller's real error.
    }
    try {
      await deleteCredentialJournal(clientId);
    } catch {
      // The token TTL still retires the credential; the journal is a leak to
      // clean, not a reason to lose the call result.
    }
  }
}

/** Call `get_usage` over the MCP data lane. The streamable-transport contract
 *  accepts BOTH content types and answers with SSE. */
async function callGetUsage(endpoint: string, accessToken: string, days: number): Promise<unknown> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_usage', arguments: { days } },
    }),
    ...tlsOption(),
  } as RequestInit);
  if (!res.ok) throw new Error(`get_usage MCP call failed: HTTP ${res.status}`);
  const message = parseMcpMessage(await res.text(), res.headers.get('content-type') ?? '', 'get_usage');
  return readToolText(message, 'get_usage');
}

/** The bearer out of a grant's private handoff. A malformed handoff is a
 *  failure, never a token-shaped `undefined` we would send to gbrain. */
function readAccessToken(handoff: unknown): string {
  if (handoff && typeof handoff === 'object' && 'access_token' in handoff
    && typeof handoff.access_token === 'string' && handoff.access_token.length > 0) {
    return handoff.access_token;
  }
  throw new Error('usage token handoff carried no access_token');
}

/** The client id in an `mcp.grant` receipt. Mirrors the control lane's parser
 *  (`src/control/connections.ts`) without importing the control-plane module
 *  graph into the ops process. */
function grantedClientId(json: unknown): string {
  if (!json || typeof json !== 'object') throw new Error('mcp.grant json did not include a client id');
  const body = json as Record<string, unknown>;
  const grant = body.grant && typeof body.grant === 'object' ? body.grant as Record<string, unknown> : undefined;
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

/** snake_case → camelCase, value-for-value. `cost_usd: null` stays null — an
 *  unpriced call is counted, never priced at zero (honesty rule 3). */
function mapUsage(raw: unknown): BrainUsage {
  const u = raw as {
    window_days: number;
    totals: {
      calls: number; input_tokens: number; output_tokens: number;
      cache_read_tokens: number; cache_write_tokens: number; cost_usd: number;
    };
    by_model: { model: string; calls: number; cost_usd: number | null; unpriced_calls: number }[];
    by_phase: { phase: string; calls: number; cost_usd: number }[];
    coverage: {
      source: string; logged_since: string | null; table_present: boolean;
      priced_calls: number; unpriced_calls: number; not_covered: string[];
    };
  };
  return {
    windowDays: u.window_days,
    totals: {
      calls: u.totals.calls,
      inputTokens: u.totals.input_tokens,
      outputTokens: u.totals.output_tokens,
      cacheReadTokens: u.totals.cache_read_tokens,
      cacheWriteTokens: u.totals.cache_write_tokens,
      costUsd: u.totals.cost_usd,
    },
    byModel: (u.by_model ?? []).map((m) => ({
      model: m.model,
      calls: m.calls,
      costUsd: m.cost_usd,
      unpricedCalls: m.unpriced_calls,
    })),
    byPhase: (u.by_phase ?? []).map((p) => ({
      phase: p.phase,
      calls: p.calls,
      costUsd: p.cost_usd,
    })),
    coverage: {
      source: u.coverage.source,
      loggedSince: u.coverage.logged_since,
      tablePresent: u.coverage.table_present,
      pricedCalls: u.coverage.priced_calls,
      unpricedCalls: u.coverage.unpriced_calls,
      notCovered: u.coverage.not_covered,
    },
  };
}
