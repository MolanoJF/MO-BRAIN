import { readFileSync } from 'node:fs';
import type { OperationSpec, ParamValues } from '../contracts/types.ts';
import { buildArgv } from '../contracts/argv.ts';

export type OpsRequest = {
  op: string; params: Record<string, unknown>; json?: boolean; dryRun?: boolean;
  packOverride?: string;
};
export type OpsResponse = {
  ok: boolean; exitCode: number; argv: string[];
  stdout: string; stderr: string; json: unknown;
};

const VERSION = process.env.GBRAIN_VERSION ?? '0.50.0.0';

/** The same guard as the pack directory name in src/ops/fileplane.ts and
 *  src/control/routes/schema.ts:13. */
const PACK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The allowlist, loaded from the artifact Slice 0 generated. gbrain-ops
 * exposes exactly these operations and nothing else — there is no passthrough
 * and no way to construct arbitrary argv from a request (S2).
 */
export function loadOperations(path = `contracts/v${VERSION}/operations.json`): Record<string, OperationSpec> {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { operations: OperationSpec[] };
  return Object.fromEntries(doc.operations.map((o) => [o.id, o]));
}

export function validateRequest(ops: Record<string, OperationSpec>, body: unknown): {
  spec: OperationSpec; values: ParamValues; json: boolean; dryRun: boolean; packOverride?: string;
} {
  if (!body || typeof body !== 'object') throw new Error('body must be an object');
  const { op, params = {}, json, dryRun, packOverride } = body as OpsRequest;

  const spec = ops[op];
  if (!spec) throw new Error(`unknown operation ${op}`);
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('params must be an object');
  }

  // The ONE named env override, validated against the same guard as a pack
  // directory name. There is no general env passthrough; an attacker cannot
  // reach any other variable (S2). Absent stays absent.
  if (packOverride !== undefined && (typeof packOverride !== 'string' || !PACK_NAME.test(packOverride))) {
    throw new Error('invalid packOverride');
  }

  const values: ParamValues = {};
  for (const [k, v] of Object.entries(params)) {
    const ok =
      typeof v === 'string' || typeof v === 'boolean' ||
      (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (!ok) throw new Error(`param ${k} must be a string, string[] or boolean`);
    values[k] = v as string | string[] | boolean;
  }

  // buildArgv enforces unknown-param and required-param rules, and refuses
  // --json/--dry-run on operations that do not declare support.
  buildArgv(spec, values, { json: json ?? spec.supportsJson, dryRun: dryRun ?? false });

  return { spec, values, json: json ?? spec.supportsJson, dryRun: dryRun ?? false, packOverride };
}
