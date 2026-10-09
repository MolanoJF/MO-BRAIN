/**
 * Which schema packs Mo-brain shows, ships and protects (spec P6–P8).
 *
 * gbrain's seven bundled packs stay on disk: `schema validate` with no name
 * hardcodes gbrain-base, and gbrain-everything extends gbrain-investor
 * (docs/archive/schema-pack-findings.md S5). We only hide them.
 */
export const BUNDLED_PACKS = [
  'gbrain-base', 'gbrain-base-v2', 'gbrain-recommended',
  'gbrain-creator', 'gbrain-investor', 'gbrain-engineer', 'gbrain-everything',
  'company-brain',
] as const;

/** Bundled packs the console still lists. `company-brain` leaves with Phase 2. */
export const VISIBLE_BUNDLED_PACKS = ['gbrain-base-v2', 'company-brain'] as const;

/** The base every Mo-brain schema extends. Its entries are locked (D3). */
export const CORE_PACK = 'mobrain-core';

/** Shipped by Mo-brain, seeded at ops boot, read-only to every API. Seeding order. */
export const MANAGED_PACKS = ['mobrain-core', 'mobrain-personal'] as const;
export type ManagedPack = (typeof MANAGED_PACKS)[number];

/** Where a user's edits to each managed pack go (spec P8, D5). */
export const LAYERS: Record<ManagedPack, string> = {
  'mobrain-core': 'my-brain',
  'mobrain-personal': 'my-personal',
};

/**
 * gbrain's own packs, activatable without the core lock and labeled as not
 * built on Mo-brain core. `company-brain` leaves this list in Phase 2.
 */
export const GBRAIN_FALLBACK_PACKS = ['gbrain-base-v2', 'company-brain'] as const;

export function isManagedPack(name: string): name is ManagedPack {
  return (MANAGED_PACKS as readonly string[]).includes(name);
}

/** The layer pack that receives edits aimed at a managed pack. */
export function layerFor(parent: ManagedPack): string {
  return LAYERS[parent];
}

export function isLayerPack(name: string): boolean {
  return (Object.values(LAYERS) as string[]).includes(name);
}

export function isGbrainFallbackPack(name: string): boolean {
  return (GBRAIN_FALLBACK_PACKS as readonly string[]).includes(name);
}

/** Names a user pack may not take: the `mobrain-` prefix, layers, bundled packs. */
export function isReservedPackName(name: string): boolean {
  return name.startsWith('mobrain-') || isLayerPack(name) || (BUNDLED_PACKS as readonly string[]).includes(name);
}

/** The packs the console lists. The active pack is never hidden. */
export function visiblePackNames(names: string[], activePack: string | null): string[] {
  const bundled = BUNDLED_PACKS as readonly string[];
  const visible = VISIBLE_BUNDLED_PACKS as readonly string[];
  return names.filter((n) => !bundled.includes(n) || visible.includes(n) || n === activePack);
}
