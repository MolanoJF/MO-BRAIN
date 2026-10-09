/**
 * The core lock (rules L1–L5, plan 2026-10-09-mobrain-core-schema).
 *
 * Every Mo-brain pack except `mobrain-core` must extend it, and nothing built on
 * it may remove or redefine one of its entries. gbrain's merge lets a child
 * silently redefine a parent's type, so Mo-brain enforces this itself:
 *
 *  - L1–L4 read a pack's RAW manifest and give early, readable errors.
 *  - L5 reads the RESOLVED manifest (gbrain's own merge output) and is the
 *    authority: every core entry must be present and project identically.
 *
 * Pure functions, except `chainReachesCore`, which takes an injected reader.
 */
import coreManifest from '../ops/packs/mobrain-core.json';
import { CORE_PACK } from '../contracts/packs.ts';

export type Manifest = {
  name?: string;
  extends?: string | null;
  borrow_from?: unknown[];
  page_types?: Array<{
    name?: string; primitive?: string; path_prefixes?: string[]; aliases?: string[];
    extractable?: boolean; expert_routing?: boolean;
  }>;
  link_types?: Array<{ name?: string; inverse?: string | null; temporal?: string | null }>;
  frontmatter_links?: Array<{ page_type?: string; fields?: string[]; link_type?: string }>;
  enrichable_types?: Array<{ type?: string }>;
  filing_rules?: Array<{ kind?: string; directory?: string }>;
};

export const CORE_MANIFEST = coreManifest as Manifest;

export type Violation = { rule: 'L1' | 'L2' | 'L3' | 'L4' | 'L5'; message: string };

/** The refusal code every enforcement path answers with. */
export const CORE_LOCKED = 'CORE_LOCKED';

const MAX_HOPS = 8;

const sorted = (a: string[] | undefined) => [...(a ?? [])].sort();
const pairKey = (pageType: string, field: string) => `${pageType}\u0000${field}`;

/** A core entry reduced to the fields L5 compares. */
export type CoreProjection = {
  types: Record<string, string>;
  verbs: Record<string, string>;
  frontmatter: Record<string, string>;
  filing: Record<string, string>;
  enrichable: string[];
};

export function coreProjection(m: Manifest): CoreProjection {
  const types: Record<string, string> = {};
  for (const t of m.page_types ?? []) {
    types[t.name ?? ''] = JSON.stringify([
      t.primitive ?? '', t.path_prefixes ?? [], sorted(t.aliases), t.extractable === true, t.expert_routing === true,
    ]);
  }
  const verbs: Record<string, string> = {};
  for (const l of m.link_types ?? []) {
    verbs[l.name ?? ''] = JSON.stringify([l.inverse ?? null, l.temporal ?? null]);
  }
  const frontmatter: Record<string, string> = {};
  for (const f of m.frontmatter_links ?? []) {
    frontmatter[`${f.page_type ?? ''}\u0000${f.link_type ?? ''}`] = JSON.stringify(sorted(f.fields));
  }
  const filing: Record<string, string> = {};
  for (const r of m.filing_rules ?? []) filing[r.kind ?? ''] = r.directory ?? '';
  return {
    types, verbs, frontmatter, filing,
    enrichable: (m.enrichable_types ?? []).map((e) => e.type ?? '').sort(),
  };
}

const lockedMessage = (what: string) => `${what} comes from ${CORE_PACK} and can't be changed. Add a new type instead.`;

export function coreNames(core: Manifest = CORE_MANIFEST) {
  const types = new Set((core.page_types ?? []).map((t) => t.name ?? ''));
  const verbs = new Set<string>();
  for (const l of core.link_types ?? []) {
    if (l.name) verbs.add(l.name);
    if (l.inverse) verbs.add(l.inverse);
  }
  const pairs = new Set<string>();
  for (const f of core.frontmatter_links ?? []) {
    for (const field of f.fields ?? []) pairs.add(pairKey(f.page_type ?? '', field));
  }
  return { types, verbs, pairs };
}

/**
 * L2–L4 over a pack's OWN declarations. `managed` packs (Mo-brain's own) may
 * borrow; user packs may not (L4). L5 still guards managed packs.
 */
export function ownViolations(raw: Manifest, core: Manifest = CORE_MANIFEST, opts: { managed?: boolean } = {}): Violation[] {
  const out: Violation[] = [];
  const c = coreNames(core);

  for (const t of raw.page_types ?? []) {
    if (c.types.has(t.name ?? '')) out.push({ rule: 'L2', message: lockedMessage(`The type ${t.name}`) });
  }
  for (const l of raw.link_types ?? []) {
    if (l.name && c.verbs.has(l.name)) out.push({ rule: 'L2', message: lockedMessage(`The verb ${l.name}`) });
    if (l.inverse && c.verbs.has(l.inverse)) out.push({ rule: 'L2', message: lockedMessage(`The verb ${l.inverse}`) });
  }
  for (const f of raw.frontmatter_links ?? []) {
    for (const field of f.fields ?? []) {
      if (c.pairs.has(pairKey(f.page_type ?? '', field))) {
        out.push({ rule: 'L3', message: lockedMessage(`The ${f.page_type}.${field} link`) });
      }
    }
  }
  for (const e of raw.enrichable_types ?? []) {
    if (c.types.has(e.type ?? '')) out.push({ rule: 'L3', message: lockedMessage(`Enrichment for ${e.type}`) });
  }
  for (const r of raw.filing_rules ?? []) {
    if (c.types.has(r.kind ?? '')) out.push({ rule: 'L3', message: lockedMessage(`The filing rule for ${r.kind}`) });
  }
  if (!opts.managed && (raw.borrow_from ?? []).length > 0) {
    out.push({ rule: 'L4', message: 'borrow_from is not allowed on a custom schema. Extend mobrain-core and add types instead.' });
  }
  return out;
}

/** L5: the resolved manifest must contain every core entry, unchanged. */
export function resolvedViolations(resolved: Manifest, core: Manifest = CORE_MANIFEST): Violation[] {
  const want = coreProjection(core);
  const got = coreProjection(resolved);
  const out: Violation[] = [];
  const miss = (what: string, name: string, present: boolean) =>
    out.push({ rule: 'L5', message: lockedMessage(`${what} ${name}`) + (present ? ' It was changed.' : ' It is missing.') });

  for (const [n, p] of Object.entries(want.types)) if (got.types[n] !== p) miss('The type', n, n in got.types);
  for (const [n, p] of Object.entries(want.verbs)) if (got.verbs[n] !== p) miss('The verb', n, n in got.verbs);
  for (const [k, p] of Object.entries(want.frontmatter)) {
    if (got.frontmatter[k] !== p) miss('The frontmatter link', k.replace('\u0000', ' → '), k in got.frontmatter);
  }
  for (const [k, p] of Object.entries(want.filing)) if (got.filing[k] !== p) miss('The filing rule for', k, k in got.filing);
  for (const e of want.enrichable) if (!got.enrichable.includes(e)) miss('Enrichment for', e, false);
  return out;
}

export type ChainResult = { ok: true } | { ok: false; reason: string };

/**
 * L1: the `extends` chain, read from RAW manifests, ends at mobrain-core.
 * Cycle- and depth-guarded (at most 8 hops). A missing `extends` means
 * gbrain-base to gbrain (fact 3), and a null one ends the chain.
 */
export async function chainReachesCore(
  name: string,
  showRaw: (pack: string) => Promise<Manifest | null>,
): Promise<ChainResult> {
  const seen = new Set<string>();
  let cur: string | null = name;
  for (let hops = 0; hops <= MAX_HOPS; hops++) {
    if (cur === CORE_PACK) return { ok: true };
    if (cur === null) return { ok: false, reason: `${name} does not build on ${CORE_PACK}. Set extends to "${CORE_PACK}".` };
    if (seen.has(cur)) return { ok: false, reason: `${name} has a circular extends chain at ${cur}.` };
    seen.add(cur);
    const m = await showRaw(cur);
    if (!m) return { ok: false, reason: `${cur} is not an installed schema pack.` };
    cur = m.extends === undefined ? 'gbrain-base' : m.extends;
  }
  return { ok: false, reason: `${name}'s extends chain is longer than ${MAX_HOPS} packs.` };
}
