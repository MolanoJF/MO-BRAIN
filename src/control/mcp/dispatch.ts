/**
 * Spec agent-control-mcp D3 / review R2: a tool call runs the existing route
 * in-process through the app's own fetch, with the resolved caller in `env`.
 * The route's guard, company-mode gate and audit row are the policy; this file
 * only filters by role (visibility), validates arguments, and audits the call.
 */
import { ROLE_RANK, type Role } from '../rbac.ts';
import { validateArgs } from './args.ts';
import { auditControlCall, type CallOutcome } from './audit.ts';
import { controlEnv, guardMinOf, type ControlCaller } from './callerEnv.ts';
import type { HttpMethod, ToolDef, ToolListing, ToolResult } from './registry.ts';

export type RouteFetch = (req: Request, env: unknown) => Response | Promise<Response>;
export type RouteReply = { status: number; body: any; guard: Role | null };

/** Never resolved or dialed: the request goes straight into `app.fetch`. */
const INTERNAL_ORIGIN = 'http://control-mcp.internal';

export async function callRoute(
  fetchRoute: RouteFetch, caller: ControlCaller, method: HttpMethod, path: string, body?: unknown,
): Promise<RouteReply> {
  const env = controlEnv(caller);
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetchRoute(new Request(`${INTERNAL_ORIGIN}${path}`, init), env);
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = { error: 'non_json_response' }; }
  }
  return { status: res.status, body: parsed, guard: guardMinOf(env) };
}

export function visibleTools(tools: readonly ToolDef[], role: Role): ToolDef[] {
  return tools.filter((t) => ROLE_RANK[role] >= ROLE_RANK[t.minRole]);
}

export function listingOf(tool: ToolDef): ToolListing {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input,
    annotations: { readOnlyHint: !tool.mutating, destructiveHint: Boolean(tool.gated), idempotentHint: !tool.mutating },
  };
}

function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : { value: v };
}

function result(body: unknown, isError: boolean): ToolResult {
  const structured = asObject(body);
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError };
}

function keysOf(args: unknown): string[] | undefined {
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args).sort() : undefined;
}

function errorCode(body: unknown): string | undefined {
  const e = asObject(body).error;
  return typeof e === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(e) ? e : undefined;
}

export async function runTool(opts: {
  tools: readonly ToolDef[]; fetchRoute: RouteFetch; caller: ControlCaller; name: string; args: unknown;
}): Promise<ToolResult> {
  const { caller, name } = opts;
  const argKeys = keysOf(opts.args);
  const audit = (outcome: CallOutcome, extra: { status?: number; error?: string; guard?: Role | null } = {}) =>
    auditControlCall({ orgId: caller.orgId, actor: caller.userId, tool: name, clientId: caller.clientId, outcome, argKeys, ...extra });

  const tool = opts.tools.find((t) => t.name === name);
  if (!tool || ROLE_RANK[caller.role] < ROLE_RANK[tool.minRole]) {
    // Same answer for "no such tool" and "above your role": tools/list never showed it.
    await audit('refused', { error: 'unknown_tool' });
    return result({ error: 'unknown_tool', tool: name }, true);
  }

  const checked = validateArgs(tool.input, opts.args);
  if (!checked.ok) {
    await audit('refused', { error: 'invalid_arguments' });
    return result({ error: 'invalid_arguments', errors: checked.errors }, true);
  }

  let reply: RouteReply;
  try {
    const req = tool.route(checked.args);
    reply = await callRoute(opts.fetchRoute, caller, req.method, req.path, req.body);
  } catch {
    await audit('error', { error: 'route_threw' });
    return result({ error: 'internal_error' }, true);
  }
  const ok = reply.status >= 200 && reply.status < 300;
  await audit(ok ? 'ok' : 'error', { status: reply.status, guard: reply.guard, error: ok ? undefined : errorCode(reply.body) });
  return result(ok ? reply.body : { status: reply.status, ...asObject(reply.body) }, !ok);
}
