export type McpCaller = <T = unknown>(tool: string, args: Record<string, unknown>) => Promise<T>;

export class McpError extends Error {
  constructor(message: string, readonly status: number, readonly tool: string, readonly code: string | null = null) { super(message); }
}

/** gbrain's tool failures are JSON carrying a machine `code`; keep it so a route can pick a status. */
function toolErrorCode(text: string): string | null {
  try {
    const j = JSON.parse(text) as { code?: unknown; error?: unknown };
    const c = j.code ?? j.error;
    return typeof c === 'string' ? c : null;
  } catch { return null; }
}

function parseMessage(text: string, contentType: string): Record<string, unknown> {
  const frames: unknown[] = [];
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try { frames.push(JSON.parse(t.slice(5).trim())); } catch { /* not JSON */ }
    }
  } else {
    try { frames.push(JSON.parse(text)); } catch { /* fall through */ }
  }
  for (const f of frames) {
    if (f && typeof f === 'object' && ('result' in f || 'error' in f)) return f as Record<string, unknown>;
  }
  throw new Error('MCP reply carried no JSON-RPC message');
}

export function mcpCaller(url: string, token: string, fetchImpl: typeof fetch = fetch): McpCaller {
  let id = 0;
  return async <T>(tool: string, args: Record<string, unknown>): Promise<T> => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new McpError(`${tool}: HTTP ${res.status}`, res.status, tool);
    const msg = parseMessage(await res.text(), res.headers.get('content-type') ?? '');
    if ('error' in msg) {
      const e = msg.error as { message?: string };
      throw new McpError(`${tool}: ${e?.message ?? 'error'}`, 502, tool);
    }
    const result = msg.result as { isError?: boolean; content?: { type?: string; text?: string }[] };
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
    if (result.isError) throw new McpError(`${tool}: ${text}`, 422, tool, toolErrorCode(text));
    try { return JSON.parse(text) as T; } catch { return text as T; }
  };
}
