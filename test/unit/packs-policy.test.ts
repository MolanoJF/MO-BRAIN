import { test, expect } from 'bun:test';
import { visiblePackNames, isManagedPack, BUNDLED_PACKS, LAYER_PACK } from '../../src/contracts/packs.ts';
import { validateDraft } from '../../src/control/schemaDraft.ts';

const ALL = [...BUNDLED_PACKS, 'mobrain-personal', 'my-personal', 'legal-ops'];

test('only gbrain-base-v2 survives among bundled packs', () => {
  expect(visiblePackNames(ALL, 'mobrain-personal'))
    .toEqual(['gbrain-base-v2', 'mobrain-personal', 'my-personal', 'legal-ops']);
});

test('a legacy brain still sees its hidden active pack', () => {
  expect(visiblePackNames(ALL, 'gbrain-investor')).toContain('gbrain-investor');
});

test('managed names', () => {
  expect(isManagedPack('mobrain-personal')).toBe(true);
  expect(isManagedPack(LAYER_PACK)).toBe(false);
});

test('a draft cannot take a managed or layer name', () => {
  const draft = (name: string) => ({ name, description: 'x', extends: null, pageTypes: [
    { name: 't', primitive: 'entity', folder: 't/', description: '', extraPrefixes: [], aliases: [], extractable: false, expertRouting: false },
  ], linkVerbs: [] });
  for (const n of ['mobrain-personal', 'my-personal']) {
    const v = validateDraft(draft(n));
    expect(v.ok).toBe(false);
  }
});
