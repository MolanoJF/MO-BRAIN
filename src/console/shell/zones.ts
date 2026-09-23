import type { SpaceSummary } from '../api.ts';

export type ZoneGroup = { label: 'My Brain' | 'Company'; spaces: SpaceSummary[] };

/** Zones spec §1: your own Spaces first, then what the company shares with you. */
export function groupByZone(spaces: SpaceSummary[]): ZoneGroup[] {
  const groups: ZoneGroup[] = [
    { label: 'My Brain', spaces: spaces.filter((s) => s.zone === 'personal') },
    { label: 'Company', spaces: spaces.filter((s) => s.zone !== 'personal') },
  ];
  return groups.filter((g) => g.spaces.length > 0);
}
