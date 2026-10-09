import { test, expect } from 'bun:test';
import {
  visiblePackNames, isManagedPack, isLayerPack, isGbrainFallbackPack, isReservedPackName, layerFor,
  BUNDLED_PACKS, MANAGED_PACKS, CORE_PACK, GBRAIN_FALLBACK_PACKS,
} from '../../src/contracts/packs.ts';
import { validateDraft } from '../../src/control/schemaDraft.ts';

const ALL = [...BUNDLED_PACKS, 'mobrain-core', 'mobrain-personal', 'my-brain', 'my-personal', 'legal-ops'];

test('only gbrain-base-v2 and company-brain survive among bundled packs', () => {
  expect(visiblePackNames(ALL, 'mobrain-core'))
    .toEqual(['gbrain-base-v2', 'company-brain', 'mobrain-core', 'mobrain-personal', 'my-brain', 'my-personal', 'legal-ops']);
});

test('company-brain is bundled, not an editable user pack', () => {
  expect((BUNDLED_PACKS as readonly string[]).includes('company-brain')).toBe(true);
});

test('a legacy brain still sees its hidden active pack', () => {
  expect(visiblePackNames(ALL, 'gbrain-investor')).toContain('gbrain-investor');
});

test('managed packs are seeded core first', () => {
  expect([...MANAGED_PACKS]).toEqual(['mobrain-core', 'mobrain-personal']);
  expect(CORE_PACK).toBe('mobrain-core');
});

test('managed names and their layers', () => {
  expect(isManagedPack('mobrain-core')).toBe(true);
  expect(isManagedPack('mobrain-personal')).toBe(true);
  expect(isManagedPack('my-brain')).toBe(false);
  expect(layerFor('mobrain-core')).toBe('my-brain');
  expect(layerFor('mobrain-personal')).toBe('my-personal');
  expect(isLayerPack('my-brain') && isLayerPack('my-personal')).toBe(true);
  expect(isLayerPack('legal-ops')).toBe(false);
});

test('gbrain fallback packs are labeled as such', () => {
  expect([...GBRAIN_FALLBACK_PACKS]).toEqual(['gbrain-base-v2', 'company-brain']);
  expect(isGbrainFallbackPack('gbrain-base-v2')).toBe(true);
  expect(isGbrainFallbackPack('mobrain-core')).toBe(false);
});

test('reserved names: the mobrain- prefix, every layer, every bundled name', () => {
  for (const n of ['mobrain-anything', 'mobrain-core', 'my-brain', 'my-personal', 'company-brain', 'gbrain-base-v2']) {
    expect(isReservedPackName(n)).toBe(true);
  }
  expect(isReservedPackName('legal-ops')).toBe(false);
});

const draft = (name: string, ext: string | null = 'mobrain-core') => ({ name, description: 'x', extends: ext, pageTypes: [
  { name: 't', primitive: 'entity', folder: 't/', description: '', extraPrefixes: [], aliases: [], extractable: false, expertRouting: false },
], linkVerbs: [] });

test('a draft cannot take a managed, layer or mobrain- name', () => {
  for (const n of ['mobrain-personal', 'mobrain-core', 'my-personal', 'my-brain', 'mobrain-x']) {
    expect(validateDraft(draft(n)).ok).toBe(false);
  }
});

test('a draft must extend something, and cannot redeclare core', () => {
  expect(validateDraft(draft('legal-ops', null)).ok).toBe(false);
  expect(validateDraft(draft('legal-ops')).ok).toBe(true);
  const redeclared = { ...draft('legal-ops'), pageTypes: [{ ...draft('x').pageTypes[0]!, name: 'person' }] };
  const v = validateDraft(redeclared);
  expect(v.ok).toBe(false);
  const verb = { ...draft('legal-ops'), linkVerbs: [{ name: 'part_of' }, { name: 'a_b', inverse: 'has_part' }] };
  const vv = validateDraft(verb);
  expect(vv.ok === false && vv.errors.length).toBe(2);
});
