import core from '../../ops/packs/mobrain-core.json';
import { CORE_PACK, LAYERS, isGbrainFallbackPack, isLayerPack, isManagedPack, type ManagedPack } from '../../contracts/packs.ts';

/**
 * What the console shows about the core lock. The server is the authority
 * (coreLock.ts); these are labels and option filters, kept pure so they can be
 * tested without a DOM.
 */
type PackRef = { name: string; extends: string | null; bundled: boolean; managed: boolean };

/** Core's own type and verb names (verbs include inverses). */
export const CORE_TYPE_NAMES: ReadonlySet<string> = new Set(core.page_types.map((t) => t.name));
export const CORE_VERB_NAMES: ReadonlySet<string> = new Set(
  core.link_types.flatMap((l) => ('inverse' in l && l.inverse ? [l.name, l.inverse] : [l.name])),
);

/** True when the `extends` chain, read from the listed packs, ends at mobrain-core. */
export function reachesCore(name: string, packs: PackRef[]): boolean {
  const by = new Map(packs.map((p) => [p.name, p]));
  const seen = new Set<string>();
  let cur: string | null = name;
  while (cur !== null && !seen.has(cur) && seen.size <= 8) {
    if (cur === CORE_PACK) return true;
    seen.add(cur);
    cur = by.get(cur)?.extends ?? null;
  }
  return false;
}

/** The "Builds on" choices: only packs that reach core. Never "nothing". */
export function buildsOnOptions(packs: PackRef[]): string[] {
  return packs.filter((p) => reachesCore(p.name, packs)).map((p) => p.name);
}

/** "Start from template" forks user packs only (a fork of core would be unlocked). */
export function templateOptions(packs: PackRef[]): string[] {
  return packs
    .filter((p) => !p.bundled && !p.managed && !isLayerPack(p.name) && reachesCore(p.name, packs))
    .map((p) => p.name);
}

/** The line under a pack's name in the pack list. Null for an ordinary custom pack. */
export function packBadge(d: PackRef): string | null {
  if (d.name === CORE_PACK) return 'Mo-brain core · base of every schema · locked';
  if (d.managed) return `extends ${d.extends ?? CORE_PACK}`;
  if (isGbrainFallbackPack(d.name) || d.bundled) return 'gbrain pack · not built on Mo-brain core';
  return null;
}

/** The label on a pack's edit button, or null when it has none (a bundled gbrain pack). */
export function editLabel(d: Pick<PackRef, 'bundled' | 'managed'>): string | null {
  if (d.bundled) return null;
  return d.managed ? 'Customize' : 'Edit';
}

/** Where edits aimed at a managed pack go, with the reason. */
export function managedEditNote(name: string): string {
  const layer = isManagedPack(name) ? LAYERS[name as ManagedPack] : 'a layer';
  const own = name === CORE_PACK ? 'Core is locked, so its types and verbs cannot be removed or changed' : `Types that come from ${name} cannot be removed`;
  return `${name} is maintained by Mo-brain. Your changes go into ${layer}, layered on top, so Mo-brain updates still reach you. ${own}; add new ones instead.`;
}

/** The badge on an inherited row. `locked` rows come from core. */
export function inheritedBadge(kind: 'type' | 'verb', name: string, parent: string | null): { text: string; locked: boolean } {
  const names = kind === 'type' ? CORE_TYPE_NAMES : CORE_VERB_NAMES;
  return names.has(name)
    ? { text: `🔒 from ${CORE_PACK}`, locked: true }
    : { text: `from ${parent ?? 'a parent pack'}`, locked: false };
}
