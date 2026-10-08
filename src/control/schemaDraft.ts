/**
 * PackDraft: the ONE shape a custom ontology travels in, whether an admin
 * builds it in the console, an agent drafts it with the mobrain-schema-designer
 * skill, or someone pastes it into "Import draft". camelCase on our side; only
 * draftToManifest speaks gbrain's snake_case (S4 field names).
 *
 * Validation here is a FRONT gate for good error messages. gbrain's own
 * `schema validate` + `schema lint` still run after every write and remain
 * the authority. We never reimplement the extends merge, which is why link
 * verbs that name a type the parent might provide are allowed when `extends`
 * is set.
 */
export const PACK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TYPE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const VERB_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export const PRIMITIVES = ['entity', 'media', 'temporal', 'annotation', 'concept'] as const;
export type Primitive = typeof PRIMITIVES[number];
export { BUNDLED_PACKS } from '../contracts/packs.ts';
import { BUNDLED_PACKS, MANAGED_PACKS, LAYER_PACK } from '../contracts/packs.ts';

export type DraftPageType = {
  name: string; primitive: Primitive; folder: string; description: string;
  extraPrefixes: string[]; aliases: string[]; extractable: boolean; expertRouting: boolean;
};
export type DraftLinkVerb = { name: string; inverse?: string; fromType?: string; toType?: string };
export type PackDraft = {
  name: string; description: string; extends: string | null;
  pageTypes: DraftPageType[]; linkVerbs: DraftLinkVerb[];
};

/** A repo-relative directory: segments of [a-z0-9_-], trailing slash, no traversal. */
export function isFolder(p: unknown): p is string {
  return typeof p === 'string' && /^([a-z0-9][a-z0-9_-]*\/)+$/.test(p) && p.length <= 200;
}

const str = (v: unknown, d = '') => (typeof v === 'string' ? v.trim() : d);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function validateDraft(input: unknown): { ok: true; draft: PackDraft } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const o = (input ?? {}) as Record<string, unknown>;
  const name = str(o.name);
  if (!PACK_NAME.test(name)) errors.push('name must be lowercase letters, digits and hyphens');
  if ((BUNDLED_PACKS as readonly string[]).includes(name)) errors.push(`${name} is a bundled pack name`);
  if ((MANAGED_PACKS as readonly string[]).includes(name) || name === LAYER_PACK) {
    errors.push(`${name} is reserved by Mo-brain`);
  }
  const ext = o.extends === null || o.extends === undefined || o.extends === '' ? null : str(o.extends);
  if (ext !== null && !PACK_NAME.test(ext)) errors.push(`extends ${ext} is not a pack name`);
  if (ext === name) errors.push('a pack cannot extend itself');

  const rawTypes = Array.isArray(o.pageTypes) ? o.pageTypes : [];
  if (rawTypes.length === 0 && ext === null) errors.push('a standalone pack needs at least one page type');
  const seenTypes = new Set<string>();
  const seenFolders = new Set<string>();
  const pageTypes: DraftPageType[] = rawTypes.map((raw, i) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const tn = str(t.name);
    const label = `pageTypes[${i}] (${tn || 'unnamed'})`;
    if (!TYPE_NAME.test(tn)) errors.push(`${label}: name must start with a letter; lowercase, digits, - or _`);
    if (seenTypes.has(tn)) errors.push(`${label}: duplicate type name`);
    seenTypes.add(tn);
    const primitive = str(t.primitive) as Primitive;
    if (!(PRIMITIVES as readonly string[]).includes(primitive)) {
      errors.push(`${label}: primitive must be one of ${PRIMITIVES.join(', ')}`);
    }
    const folder = str(t.folder);
    if (!isFolder(folder)) errors.push(`${label}: folder must look like "contracts/" (lowercase, trailing slash, no ..)`);
    const extra = strs(t.extraPrefixes);
    for (const p of [folder, ...extra]) {
      if (p && !isFolder(p)) { if (p !== folder) errors.push(`${label}: prefix ${p} is not a folder path`); continue; }
      if (seenFolders.has(p)) errors.push(`${label}: ${p} is already claimed by another type`);
      seenFolders.add(p);
    }
    return {
      name: tn, primitive, folder, description: str(t.description), extraPrefixes: extra,
      aliases: strs(t.aliases), extractable: t.extractable === true, expertRouting: t.expertRouting === true,
    };
  });

  const rawVerbs = Array.isArray(o.linkVerbs) ? o.linkVerbs : [];
  const seenVerbs = new Set<string>();
  const linkVerbs: DraftLinkVerb[] = rawVerbs.map((raw, i) => {
    const v = (raw ?? {}) as Record<string, unknown>;
    const vn = str(v.name);
    if (!VERB_NAME.test(vn)) errors.push(`linkVerbs[${i}]: name must be snake_case`);
    if (seenVerbs.has(vn)) errors.push(`linkVerbs[${i}]: duplicate verb ${vn}`);
    seenVerbs.add(vn);
    const inverse = str(v.inverse) || undefined;
    if (inverse && !VERB_NAME.test(inverse)) errors.push(`linkVerbs[${i}]: inverse must be snake_case`);
    const fromType = str(v.fromType) || undefined;
    const toType = str(v.toType) || undefined;
    // Only a standalone pack can be checked here; with `extends`, the parent's
    // types are gbrain's to resolve, and lint catches a dangling reference.
    if (ext === null) {
      for (const [k, t] of [['fromType', fromType], ['toType', toType]] as const) {
        if (t && !seenTypes.has(t)) errors.push(`linkVerbs[${i}]: ${k} ${t} is not a type in this pack`);
      }
    }
    return { name: vn, inverse, fromType, toType };
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, draft: { name, description: str(o.description), extends: ext, pageTypes, linkVerbs } };
}

export function draftToManifest(d: PackDraft, gbrainMinVersion: string): Record<string, unknown> {
  return {
    api_version: 'gbrain-schema-pack-v1',
    name: d.name,
    version: '0.1.0',
    gbrain_min_version: gbrainMinVersion.split('.').slice(0, 3).join('.'),
    // gbrain's manifest zod defaults a MISSING extends to 'gbrain-base'
    // (z.string().nullable().default('gbrain-base')), so a standalone ontology
    // must say `extends: null` explicitly. Omitting the key silently inherits
    // the base pack (S7).
    extends: d.extends,
    description: d.description,
    page_types: d.pageTypes.map((t) => ({
      name: t.name, primitive: t.primitive,
      path_prefixes: [t.folder, ...t.extraPrefixes], aliases: t.aliases,
      extractable: t.extractable, expert_routing: t.expertRouting,
    })),
    link_types: d.linkVerbs.map((v) => ({
      name: v.name,
      ...(v.inverse ? { inverse: v.inverse } : {}),
      ...(v.fromType || v.toType
        ? { inference: { ...(v.fromType ? { page_type: v.fromType } : {}), ...(v.toType ? { target_type: v.toType } : {}) } }
        : {}),
    })),
    takes_kinds: ['fact', 'take', 'bet', 'hunch'],
    borrow_from: [],
    frontmatter_links: [],
    enrichable_types: [],
    filing_rules: d.pageTypes.map((t) => ({
      kind: t.name, directory: t.folder, examples: [], ...(t.description ? { description: t.description } : {}),
    })),
  };
}

/** gbrain's applyMutationsAtomic vocabulary (src/core/schema-pack/mutate.ts). */
export type PackMutation =
  | { op: 'add_type'; name: string; primitive: Primitive; prefix: string; extractable?: boolean; expert_routing?: boolean; aliases?: string[] }
  | { op: 'remove_type'; name: string }
  | { op: 'update_type'; name: string; patch: { primitive?: Primitive; extractable?: boolean; expert_routing?: boolean } }
  | { op: 'add_alias' | 'remove_alias'; type: string; alias: string }
  | { op: 'add_prefix' | 'remove_prefix'; type: string; prefix: string }
  | { op: 'add_link_type'; name: string; inverse?: string; inference?: { page_type?: string; target_type?: string } }
  | { op: 'remove_link_type'; name: string }
  | { op: 'set_extractable' | 'set_expert_routing'; type: string; value: boolean };

const OPS = new Set(['add_type', 'remove_type', 'update_type', 'add_alias', 'remove_alias', 'add_prefix',
  'remove_prefix', 'add_link_type', 'remove_link_type', 'set_extractable', 'set_expert_routing']);

export function validateMutations(input: unknown): { ok: true; mutations: PackMutation[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, errors: ['mutations must be a non-empty array'] };
  if (input.length > 200) return { ok: false, errors: ['at most 200 mutations per batch'] };
  const errors: string[] = [];
  input.forEach((m, i) => {
    const o = (m ?? {}) as Record<string, unknown>;
    if (typeof o.op !== 'string' || !OPS.has(o.op)) { errors.push(`[${i}]: unknown op ${String(o.op)}`); return; }
    if ('prefix' in o && !isFolder(o.prefix)) errors.push(`[${i}]: prefix must be a folder path like "memos/"`);
    if ('primitive' in o && !(PRIMITIVES as readonly string[]).includes(String(o.primitive))) errors.push(`[${i}]: bad primitive`);
    for (const k of ['name', 'type', 'alias'] as const) {
      if (k in o && (typeof o[k] !== 'string' || !TYPE_NAME.test(o[k] as string) && !VERB_NAME.test(o[k] as string))) {
        errors.push(`[${i}]: ${k} is not a valid identifier`);
      }
    }
  });
  return errors.length ? { ok: false, errors } : { ok: true, mutations: input as PackMutation[] };
}
