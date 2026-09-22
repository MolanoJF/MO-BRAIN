import { test, expect, describe } from 'bun:test';
import { validateDraft, draftToManifest, validateMutations } from '../../src/control/schemaDraft.ts';

const good = {
  name: 'legal-ops',
  description: 'Contracts and counterparties',
  extends: 'gbrain-base-v2',
  pageTypes: [
    { name: 'contract', primitive: 'entity', folder: 'contracts/', description: 'A signed agreement',
      extraPrefixes: ['legal/contracts/'], aliases: [], extractable: true, expertRouting: false },
    { name: 'matter', primitive: 'temporal', folder: 'matters/', description: 'A legal matter',
      extraPrefixes: [], aliases: [], extractable: false, expertRouting: false },
  ],
  linkVerbs: [{ name: 'governs', inverse: 'governed_by', fromType: 'contract', toType: 'matter' }],
};

describe('validateDraft', () => {
  test('accepts a well-formed draft', () => {
    expect(validateDraft(good).ok).toBe(true);
  });
  test('rejects a bundled name', () => {
    const r = validateDraft({ ...good, name: 'gbrain-base-v2' });
    expect(r.ok).toBe(false);
  });
  test('rejects an unknown primitive, a traversing folder and a folder without a trailing slash', () => {
    const r = validateDraft({ ...good, pageTypes: [
      { ...good.pageTypes[0], primitive: 'thing' },
      { ...good.pageTypes[1], folder: '../etc/' },
      { ...good.pageTypes[1], name: 'memo', folder: 'memos' },
    ] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBe(3);
  });
  test('rejects duplicate type names and two types claiming one folder', () => {
    const r = validateDraft({ ...good, pageTypes: [good.pageTypes[0], { ...good.pageTypes[0] }] });
    expect(r.ok).toBe(false);
  });
  test('rejects a link verb naming a type the draft does not declare, when there is no extends', () => {
    const r = validateDraft({ ...good, extends: null,
      linkVerbs: [{ name: 'employs', fromType: 'company', toType: 'person' }] });
    expect(r.ok).toBe(false);
  });
  test('allows a link verb to a type the parent may provide when extends is set', () => {
    const r = validateDraft({ ...good, linkVerbs: [{ name: 'signed', fromType: 'person', toType: 'contract' }] });
    expect(r.ok).toBe(true);
  });
});

describe('draftToManifest', () => {
  test('emits gbrain snake_case with folder as the first prefix and a filing rule', () => {
    const r = validateDraft(good);
    if (!r.ok) throw new Error('fixture');
    const m = draftToManifest(r.draft, '0.50.5.0') as any;
    expect(m.api_version).toBe('gbrain-schema-pack-v1');
    expect(m.version).toBe('0.1.0');
    expect(m.extends).toBe('gbrain-base-v2');
    expect(m.page_types[0]).toEqual({
      name: 'contract', primitive: 'entity',
      path_prefixes: ['contracts/', 'legal/contracts/'], aliases: [],
      extractable: true, expert_routing: false,
    });
    expect(m.link_types[0]).toEqual({
      name: 'governs', inverse: 'governed_by', inference: { page_type: 'contract', target_type: 'matter' },
    });
    expect(m.filing_rules[0]).toEqual({
      kind: 'contract', directory: 'contracts/', examples: [], description: 'A signed agreement',
    });
  });
  test('emits an explicit extends:null for a standalone ontology', () => {
    const r = validateDraft({ ...good, extends: null, linkVerbs: [] });
    if (!r.ok) throw new Error('fixture');
    const m = draftToManifest(r.draft, '0.50.5.0');
    expect('extends' in m).toBe(true);
    expect(m.extends).toBeNull();
  });
});

describe('validateMutations', () => {
  test('accepts the gbrain op vocabulary and rejects anything else', () => {
    expect(validateMutations([{ op: 'add_type', name: 'memo', primitive: 'annotation', prefix: 'memos/' }]).ok).toBe(true);
    expect(validateMutations([{ op: 'drop_table' }]).ok).toBe(false);
    expect(validateMutations([]).ok).toBe(false);
  });
  test('rejects a traversing prefix inside a mutation', () => {
    expect(validateMutations([{ op: 'add_prefix', type: 'memo', prefix: '../x/' }]).ok).toBe(false);
  });
});
