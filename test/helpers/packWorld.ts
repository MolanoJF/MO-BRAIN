// test/helpers/packWorld.ts
// A fake gbrain pack store for the core lock's reads (`schema.showRaw` and the
// resolved `schema.show` with the packOverride seam). Routes under test call
// both; this answers them with realistic manifests so the lock can run.
import core from '../../src/ops/packs/mobrain-core.json';
import personal from '../../src/ops/packs/mobrain-personal.json';
import type { Manifest } from '../../src/control/coreLock.ts';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Raw manifests by pack name. Tests add or replace entries per case. */
export const rawPacks: Record<string, Manifest> = {};

export function resetPackWorld(): void {
  for (const k of Object.keys(rawPacks)) delete rawPacks[k];
  rawPacks['mobrain-core'] = clone(core) as Manifest;
  rawPacks['mobrain-personal'] = clone(personal) as Manifest;
  rawPacks['gbrain-base-v2'] = { name: 'gbrain-base-v2', extends: 'gbrain-base', page_types: [{ name: 'person', primitive: 'entity', path_prefixes: ['people/'] }] };
  rawPacks['gbrain-base'] = { name: 'gbrain-base', extends: null, page_types: [{ name: 'person', primitive: 'entity', path_prefixes: ['people/'] }] };
}
resetPackWorld();

/** gbrain's merge, reduced to what the lock reads: child wins per key. */
export function resolve(name: string, seen = new Set<string>()): Manifest {
  const raw = rawPacks[name];
  if (!raw) throw new Error(`unknown pack ${name}`);
  const parent = raw.extends && !seen.has(raw.extends) && rawPacks[raw.extends] ? resolve(raw.extends, new Set([...seen, name])) : null;
  const merge = <T>(a: T[] | undefined, b: T[] | undefined, key: (x: T) => string): T[] => {
    const own = b ?? [];
    const ownKeys = new Set(own.map(key));
    return [...own, ...(a ?? []).filter((x) => !ownKeys.has(key(x)))];
  };
  return {
    ...raw,
    page_types: merge(parent?.page_types, raw.page_types, (t) => t.name ?? ''),
    link_types: merge(parent?.link_types, raw.link_types, (l) => l.name ?? ''),
    frontmatter_links: merge(parent?.frontmatter_links, raw.frontmatter_links, (f) => `${f.page_type}/${f.link_type}`),
    enrichable_types: merge(parent?.enrichable_types, raw.enrichable_types, (e) => e.type ?? ''),
    filing_rules: merge(parent?.filing_rules, raw.filing_rules, (r) => r.kind ?? ''),
  };
}

type Reply = { ok: boolean; exitCode: number; argv: string[]; stdout: string; stderr: string; json: unknown };
const reply = (json: unknown, ok = true): Reply => ({ ok, exitCode: ok ? 0 : 1, argv: ['gbrain', 'schema'], stdout: '', stderr: '', json });

/** The answer for a lock read, or null when `op` is not one. */
export function packWorldReply(op: string, params?: Record<string, unknown>, opts?: { packOverride?: string }): Reply | null {
  if (op === 'schema.showRaw') {
    const raw = rawPacks[String(params?.packName)];
    return raw ? reply(clone(raw)) : null;
  }
  if (op === 'schema.show' && opts?.packOverride && rawPacks[opts.packOverride]) {
    return reply(clone(resolve(opts.packOverride)));
  }
  return null;
}
