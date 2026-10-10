/**
 * Spec agent-control-mcp D7 / review R3: one row per tools/call, as the human,
 * via the agent. `after` carries keys and codes only — never argument values,
 * response bodies or the bearer (S3c).
 */
import { randomUUID } from 'node:crypto';
import { getDb, schema } from '../db/client.ts';
import type { Role } from '../rbac.ts';

export const CONTROL_MCP_ACTION = 'control_mcp.call';
export const CONTROL_MCP_REFUSED_ACTION = 'control_mcp.refused';

export type CallOutcome = 'ok' | 'error' | 'refused' | 'preview';

export type ControlCallAudit = {
  orgId: string | null;
  actor: string;
  tool: string;
  clientId: string;
  outcome: CallOutcome;
  status?: number;
  error?: string;
  guard?: Role | null;
  argKeys?: string[];
};

export async function auditControlCall(e: ControlCallAudit): Promise<void> {
  await getDb().insert(schema.auditLog).values({
    id: randomUUID(), organizationId: e.orgId, actor: e.actor,
    action: CONTROL_MCP_ACTION, target: e.tool, before: null,
    after: {
      via: `control-mcp:${e.clientId}`,
      outcome: e.outcome,
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.error ? { error: e.error } : {}),
      ...(e.guard ? { guard: e.guard } : {}),
      ...(e.argKeys ? { argKeys: e.argKeys } : {}),
    },
  });
}

/** A bearer that resolved to someone but was refused (runner token, inactive Connection). */
export async function auditRefusedToken(e: { orgId: string | null; actor: string; clientId: string; error: string }): Promise<void> {
  await getDb().insert(schema.auditLog).values({
    id: randomUUID(), organizationId: e.orgId, actor: e.actor,
    action: CONTROL_MCP_REFUSED_ACTION, target: null, before: null,
    after: { via: `control-mcp:${e.clientId}`, error: e.error },
  });
}
