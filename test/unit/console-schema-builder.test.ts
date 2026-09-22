import { test, expect } from 'bun:test';
import { emptyDraft, draftFromJson, editsToMutations, folderFor } from '../../src/console/pages/SchemaBuilder.tsx';

test('folderFor turns a type name into its default folder', () => {
  expect(folderFor('contract')).toBe('contracts/');
  expect(folderFor('matter_note')).toBe('matter-notes/');
  expect(folderFor('person')).toBe('people/');
  expect(folderFor('')).toBe('');
});

test('draftFromJson accepts a skill-produced draft and reports parse errors plainly', () => {
  expect(draftFromJson('{"name":"x","pageTypes":[],"linkVerbs":[]}').ok).toBe(true);
  const bad = draftFromJson('{nope');
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.error).toMatch(/JSON/);
});

test('editsToMutations: add, remove, flag flips, prefix and verb changes, in gbrain op vocabulary', () => {
  const before = { pageTypes: [
    { name: 'contract', primitive: 'entity', pathPrefixes: ['contracts/'], aliases: [], extractable: false, expertRouting: false },
    { name: 'memo', primitive: 'annotation', pathPrefixes: ['memos/'], aliases: [], extractable: false, expertRouting: false },
  ], linkTypes: [{ name: 'governs', inverse: null, pageType: 'contract', targetType: null }] };
  const after = { pageTypes: [
    { name: 'contract', primitive: 'entity', pathPrefixes: ['contracts/', 'legal/'], aliases: ['agreement'], extractable: true, expertRouting: false },
    { name: 'matter', primitive: 'temporal', pathPrefixes: ['matters/'], aliases: [], extractable: false, expertRouting: true },
  ], linkTypes: [{ name: 'about', inverse: null, pageType: 'memo', targetType: 'matter' }] };
  expect(editsToMutations(before, after)).toEqual([
    { op: 'remove_link_type', name: 'governs' },
    { op: 'remove_type', name: 'memo' },
    { op: 'add_type', name: 'matter', primitive: 'temporal', prefix: 'matters/', extractable: false, expert_routing: true, aliases: [] },
    { op: 'add_prefix', type: 'contract', prefix: 'legal/' },
    { op: 'add_alias', type: 'contract', alias: 'agreement' },
    { op: 'set_extractable', type: 'contract', value: true },
    { op: 'add_link_type', name: 'about', inference: { page_type: 'memo', target_type: 'matter' } },
  ]);
});

test('emptyDraft extends the brain default so a first custom pack keeps the base types', () => {
  expect(emptyDraft('gbrain-base-v2').extends).toBe('gbrain-base-v2');
});
