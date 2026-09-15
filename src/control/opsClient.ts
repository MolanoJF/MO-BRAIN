import type { OpsResponse } from '../ops/dispatch.ts';

const OPS_URL = process.env.OPS_RPC_URL ?? 'http://gbrain-ops:3140';
const TOKEN = process.env.OPS_RPC_TOKEN ?? '';

async function post<T>(path: string, body: unknown, timeoutMs = 600_000): Promise<T> {
  const res = await fetch(`${OPS_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await res.json();
  if (!res.ok) throw new Error((payload as { error?: string }).error ?? `ops rpc ${res.status}`);
  return payload as T;
}

/**
 * The ONLY way the control plane reaches gbrain. It holds no brain
 * DATABASE_URL and mounts GBRAIN_HOME read-only (S2), so every privileged
 * action crosses this boundary.
 */
export async function callOps<T = unknown>(
  op: string,
  params: Record<string, unknown> = {},
  opts: { json?: boolean; dryRun?: boolean; timeoutMs?: number } = {},
): Promise<OpsResponse & { json: T | null }> {
  return post('/rpc', { op, params, json: opts.json, dryRun: opts.dryRun, timeoutMs: opts.timeoutMs },
    opts.timeoutMs);
}

export async function patchFilePlaneConfig(patch: Record<string, unknown>): Promise<void> {
  await post('/fileplane/config', { patch }, 60_000);
}

export async function putSchemaPack(name: string, yaml: string): Promise<void> {
  await post('/fileplane/schema-pack', { name, yaml }, 60_000);
}

export async function seedSpace(sourceId: string): Promise<void> {
  await post('/fileplane/seed-space', { sourceId }, 60_000);
}

export async function opsHealthy(): Promise<boolean> {
  try { return (await fetch(`${OPS_URL}/healthz`, { signal: AbortSignal.timeout(5_000) })).ok; }
  catch { return false; }
}
