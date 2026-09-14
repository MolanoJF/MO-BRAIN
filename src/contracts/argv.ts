import type { OperationSpec, ParamValues } from './types.ts';
import { REDACTED } from './types.ts';

/**
 * Build an argv ARRAY for a gbrain invocation. Never returns a shell string:
 * every value is its own element, so no value can inject an argument or a
 * shell metacharacter (G2).
 */
export function buildArgv(
  spec: OperationSpec,
  values: ParamValues,
  opts: { json?: boolean; dryRun?: boolean } = {},
): string[] {
  const known = new Set(spec.params.map((p) => p.name));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new Error(`unknown param ${key} for ${spec.id}`);
  }

  const argv: string[] = [...spec.argv];

  for (const p of spec.params) {
    const v = values[p.name];
    if (v === undefined || v === false) {
      if (p.required) throw new Error(`missing required param ${p.name} for ${spec.id}`);
      continue;
    }
    if (p.kind === 'flag') {
      argv.push(p.flag);
      continue;
    }
    if (p.kind === 'list') {
      const list = Array.isArray(v) ? v : [String(v)];
      if (list.length === 0) continue;
      argv.push(p.flag, list.join(','));
      continue;
    }
    // An empty flag means a positional argument: push the value alone.
    if (p.flag === '') { argv.push(String(v)); continue; }
    argv.push(p.flag, String(v));
  }

  if (opts.dryRun) {
    if (!spec.supportsDryRun) throw new Error(`${spec.id} does not support --dry-run`);
    argv.push('--dry-run');
  }
  if (opts.json) {
    if (!spec.supportsJson) throw new Error(`${spec.id} does not support --json`);
    argv.push('--json');
  }
  return argv;
}

/** Replace the value following any secret-bearing flag. Use before logging. */
export function redactArgv(spec: OperationSpec, argv: readonly string[]): string[] {
  const secretFlags = new Set(spec.params.filter((p) => p.secret).map((p) => p.flag));
  const out = [...argv];
  for (let i = 0; i < out.length - 1; i++) {
    if (secretFlags.has(out[i]!)) out[i + 1] = REDACTED;
  }
  return out;
}
