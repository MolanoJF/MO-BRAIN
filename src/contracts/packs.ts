/**
 * Which schema packs Mobrain shows, ships and protects (spec P6–P8).
 *
 * gbrain's seven bundled packs stay on disk: `schema validate` with no name
 * hardcodes gbrain-base, and gbrain-everything extends gbrain-investor
 * (docs/schema-pack-findings.md S5). We only hide them.
 */
export const BUNDLED_PACKS = [
  'gbrain-base', 'gbrain-base-v2', 'gbrain-recommended',
  'gbrain-creator', 'gbrain-investor', 'gbrain-engineer', 'gbrain-everything',
] as const;

export const VISIBLE_BUNDLED_PACKS = ['gbrain-base-v2'] as const;

/** Shipped by Mobrain, seeded at ops boot, read-only to every API. */
export const MANAGED_PACKS = ['mobrain-personal'] as const;

/** Where a user's edits to the managed pack go (spec P8). */
export const LAYER_PACK = 'my-personal';
export const LAYER_PARENT = 'mobrain-personal';

export function isManagedPack(name: string): boolean {
  return (MANAGED_PACKS as readonly string[]).includes(name);
}

/** The packs the console lists. The active pack is never hidden. */
export function visiblePackNames(names: string[], activePack: string | null): string[] {
  const bundled = BUNDLED_PACKS as readonly string[];
  const visible = VISIBLE_BUNDLED_PACKS as readonly string[];
  return names.filter((n) => !bundled.includes(n) || visible.includes(n) || n === activePack);
}
