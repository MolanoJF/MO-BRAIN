/**
 * The MCP DATA LANE as gbrain-ops dials it. Shared by `usage.ts` (`get_usage`)
 * and `whoami.ts` (control MCP identity, spec agent-control-mcp D2). Ops is on
 * `brain-net`; the control plane is not, which is why both live here (S2).
 */

/**
 * The MCP DATA-LANE endpoint this process dials for `get_usage`.
 *
 * Inside compose, ops is on `brain-net`, so it reaches `gbrain-serve` directly;
 * `PUBLIC_URL` is deliberately NOT set in the ops container, and a bare
 * `mcpUrl()` would resolve to 127.0.0.1 inside the wrong container. The
 * published dev override lets a host-run contract test reach the same endpoint
 * through Caddy by setting `GBRAIN_MCP_URL`.
 *
 * This is NOT the URL handed to `mcp.grant` — see `grantEndpoint()`.
 */
export function mcpEndpoint(): string {
  const explicit = process.env.GBRAIN_MCP_URL?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const publicUrl = process.env.PUBLIC_URL?.trim();
  if (publicUrl) {
    const base = publicUrl.replace(/\/+$/, '');
    return base.endsWith('/mcp') ? base : `${base}/mcp`;
  }
  // In compose, ops is on brain-net and dials gbrain-serve directly.
  return 'http://gbrain-serve:3131/mcp';
}

/** A self-signed Caddy on the dev box needs this; production is plain http on
 *  the internal network, and a real cert is never exempted. */
export function tlsOption(): { tls?: { rejectUnauthorized: boolean } } {
  return process.env.GBRAIN_MCP_TLS_INSECURE === '1'
    ? { tls: { rejectUnauthorized: false } }
    : {};
}

/** A single streamable-HTTP response is either a bare JSON-RPC object or an
 *  SSE stream of `data:` frames. Return the JSON-RPC message, error or result. */
export function parseMcpMessage(text: string, contentType: string, label: string): Record<string, unknown> {
  const frames: unknown[] = [];
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data.length === 0) continue;
      try { frames.push(JSON.parse(data)); } catch { /* not a JSON frame */ }
    }
  } else {
    try { frames.push(JSON.parse(text)); } catch { /* fall through */ }
  }
  for (const frame of frames) {
    if (frame && typeof frame === 'object' && 'result' in frame) return frame as Record<string, unknown>;
    if (frame && typeof frame === 'object' && 'error' in frame) {
      const err = (frame as { error?: { message?: string } }).error;
      throw new Error(`${label} MCP error: ${err?.message ?? 'unknown'}`);
    }
  }
  throw new Error(`${label} MCP call returned no JSON-RPC result`);
}

/** `tools/call` envelopes the operation's JSON as a text content block. */
export function readToolText(message: Record<string, unknown>, label: string): unknown {
  const result = message.result as { isError?: boolean; content?: { type?: string; text?: string }[] } | undefined;
  if (!result) throw new Error(`${label} MCP result was empty`);
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error(`${label} MCP result carried no text block`);
  if (result.isError === true) throw new Error(`${label} operation failed: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} MCP text block was not JSON`);
  }
}
