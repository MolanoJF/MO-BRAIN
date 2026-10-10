/**
 * Spec agent-control-mcp D3 / review R2: a control-MCP tool runs the existing
 * route in-process, with the caller its bearer resolved to carried in Hono's
 * `env`. `requireRole` reads it and applies the SAME rank check, so the route's
 * own guard stays the only policy.
 *
 * The key is a module-private Symbol. Production traffic reaches Hono through
 * `Bun.serve`, whose `env` is the Server object; nothing a client sends can put
 * this Symbol on it. Only `dispatch.ts` builds such an env.
 */
import type { Context } from 'hono';
import type { Role } from '../rbac.ts';

const CONTROL_CALLER = Symbol('mobrain.controlCaller');
const GUARD_MIN = Symbol('mobrain.guardMin');

export type ControlCaller = {
  userId: string;
  orgId: string;
  role: Role;
  membershipId: string;
  connectionId: string;
  clientId: string;
};

export type ControlEnv = { [CONTROL_CALLER]: ControlCaller; [GUARD_MIN]?: Role };

export function controlEnv(caller: ControlCaller): ControlEnv {
  return { [CONTROL_CALLER]: Object.freeze({ ...caller }) };
}

function envRecord(c: Context): Record<symbol, unknown> | null {
  const env = (c as { env?: unknown }).env;
  return env !== null && typeof env === 'object' ? env as Record<symbol, unknown> : null;
}

export function controlCallerOf(c: Context): ControlCaller | null {
  const value = envRecord(c)?.[CONTROL_CALLER];
  return value !== null && typeof value === 'object' ? value as ControlCaller : null;
}

/** The min role the route's guard asked for. Read back for the audit row and
 *  by the registry/guard parity test (Task 8). */
export function noteGuard(c: Context, min: Role): void {
  const env = envRecord(c);
  if (env && env[CONTROL_CALLER]) env[GUARD_MIN] = min;
}

export function guardMinOf(env: ControlEnv): Role | null {
  return env[GUARD_MIN] ?? null;
}
