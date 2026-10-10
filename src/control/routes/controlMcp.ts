/**
 * Spec agent-control-mcp D1: `POST /api/control-mcp`, the control MCP.
 *
 * Order matters: Origin (DNS rebinding), size, bearer, rate limit, THEN the
 * identity round trip — so a flood of junk costs a hash, not an ops call per
 * request after the bucket empties. A console session cookie never
 * authenticates here: only a bearer does, and the in-process route call carries
 * no cookie.
 */
import { Hono, type Context } from 'hono';
import { resolveCaller, tokenKey, type Resolution } from '../mcp/caller.ts';
import { auditControlCall, auditRefusedToken } from '../mcp/audit.ts';
import { handleRpc } from '../mcp/jsonrpc.ts';
import { createLimiter, type Limiter } from '../mcp/rateLimit.ts';
import { listingOf, runTool, visibleTools, type RouteFetch } from '../mcp/dispatch.ts';
import { TOOLS, type ToolDef } from '../mcp/registry.ts';

const MAX_BODY_BYTES = 1_048_576;

export type ControlMcpDeps = {
  resolve(bearer: string): Promise<Resolution>;
  limiter: Limiter;
  tools(): readonly ToolDef[];
  publicOrigin(): string | null;
};

export function defaultControlMcpDeps(): ControlMcpDeps {
  return {
    resolve: (bearer) => resolveCaller(bearer),
    limiter: createLimiter({ capacity: 60, refillPerSec: 1 }),
    tools: () => TOOLS,
    publicOrigin: () => {
      try { return new URL(process.env.PUBLIC_URL ?? '').origin; } catch { return null; }
    },
  };
}

function bearerOf(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1]! : null;
}

/**
 * Spec D7: every `tools/call` writes one row. `handleRpc` refuses a request
 * whose params carry no string `name` (`-32602`) before `runTool` runs, so the
 * transport — which holds the resolved caller and client id — audits that
 * refusal here, keys and codes only. The predicate mirrors `handleRpc`'s
 * `tools/call` path so the pure jsonrpc module stays DB-free; it excludes
 * notifications, which `handleRpc` answers 202 without executing anything.
 */
function refusedToolsCall(msg: unknown): { argKeys?: string[] } | null {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (m.jsonrpc !== '2.0' || m.method !== 'tools/call' || !('id' in m)) return null;
  if (typeof m.id !== 'string' && typeof m.id !== 'number' && m.id !== null) return null;
  const params = m.params !== null && typeof m.params === 'object' && !Array.isArray(m.params)
    ? m.params as Record<string, unknown> : {};
  if (typeof params.name === 'string') return null;
  const args = params.arguments;
  const argKeys = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? Object.keys(args).sort() : undefined;
  return { argKeys };
}

function unauthorized(c: Context, error: string): Response {
  return c.json({
    error,
    hint: 'Access tokens expire. Reissue this Connection\'s credential from My Brain → Connect (/my/mcp).',
  }, 401, { 'www-authenticate': 'Bearer error="invalid_token"' });
}

export function controlMcpRoutes(fetchRoute: RouteFetch, deps: ControlMcpDeps = defaultControlMcpDeps()): Hono {
  const r = new Hono();
  const notAllowed = (c: Context) => c.json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  r.get('/control-mcp', notAllowed);
  r.delete('/control-mcp', notAllowed);

  r.post('/control-mcp', async (c) => {
    const origin = c.req.header('origin');
    if (origin && origin !== deps.publicOrigin()) return c.json({ error: 'origin_not_allowed' }, 403);
    if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413);

    const bearer = bearerOf(c.req.header('authorization'));
    if (!bearer) return unauthorized(c, 'missing_token');

    const limited = deps.limiter.take(tokenKey(bearer));
    if (!limited.ok) return c.json({ error: 'rate_limited' }, 429, { 'retry-after': String(limited.retryAfterS) });

    const resolved = await deps.resolve(bearer);
    if (!resolved.ok) {
      if (resolved.audit) await auditRefusedToken({ ...resolved.audit, error: resolved.error });
      if (resolved.status === 401) return unauthorized(c, resolved.error);
      return c.json({ error: resolved.error }, resolved.status);
    }

    const text = await c.req.text();
    if (text.length > MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413);
    let msg: unknown;
    try { msg = JSON.parse(text); } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }

    const caller = resolved.caller;
    const refused = refusedToolsCall(msg);
    if (refused) {
      await auditControlCall({
        orgId: caller.orgId, actor: caller.userId, tool: null, clientId: caller.clientId,
        outcome: 'refused', error: 'invalid_arguments', argKeys: refused.argKeys,
      });
    }
    const tools = deps.tools();
    const out = await handleRpc(msg, {
      listTools: () => visibleTools(tools, caller.role).map(listingOf),
      callTool: (name, args) => runTool({ tools, fetchRoute, caller, name, args }),
    });
    return out.body === null ? c.body(null, 202) : c.json(out.body, out.status);
  });
  return r;
}
