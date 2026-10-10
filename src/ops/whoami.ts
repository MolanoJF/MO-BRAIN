/**
 * Control MCP identity (spec agent-control-mcp D2, review R1).
 *
 * The control plane has no route to gbrain-serve, so it asks ops to present a
 * member's bearer to gbrain's published `whoami` tool. gbrain does the
 * cryptographic verification; we only read the identity it returns.
 *
 * The bearer is never logged, stored or echoed (S3c).
 */
import { mcpEndpoint, parseMcpMessage, readToolText, tlsOption } from './mcpLane.ts';

export type WhoamiReply =
  | { ok: true; identity: Record<string, unknown> }
  | { ok: false; status: 400 | 401 | 502; error: string };

/** Opaque, but it lands in an HTTP header: refuse anything that could split
 *  one (CR/LF, spaces) or is absurdly long. */
const BEARER_RE = /^[A-Za-z0-9._~+/=-]{16,4096}$/;

const WHOAMI_TIMEOUT_MS = 10_000;

export async function whoamiFor(bearer: unknown, fetchImpl: typeof fetch = fetch): Promise<WhoamiReply> {
  if (typeof bearer !== 'string' || !BEARER_RE.test(bearer)) {
    return { ok: false, status: 400, error: 'invalid_bearer' };
  }
  let res: Response;
  try {
    res = await fetchImpl(mcpEndpoint(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} },
      }),
      signal: AbortSignal.timeout(WHOAMI_TIMEOUT_MS),
      ...tlsOption(),
    } as RequestInit);
  } catch {
    return { ok: false, status: 502, error: 'gbrain_unreachable' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, status: 401, error: 'invalid_token' };
  if (!res.ok) return { ok: false, status: 502, error: `gbrain_http_${res.status}` };
  try {
    const message = parseMcpMessage(await res.text(), res.headers.get('content-type') ?? '', 'whoami');
    const identity = readToolText(message, 'whoami');
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      return { ok: false, status: 502, error: 'whoami_malformed' };
    }
    return { ok: true, identity: identity as Record<string, unknown> };
  } catch {
    return { ok: false, status: 502, error: 'whoami_malformed' };
  }
}
