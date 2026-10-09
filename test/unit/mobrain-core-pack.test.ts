// test/unit/mobrain-core-pack.test.ts
import { test, expect, describe } from 'bun:test';
import pack from '../../src/ops/packs/mobrain-core.json';

type PT = { name: string; primitive: string; path_prefixes: string[]; expert_routing: boolean };
const types = pack.page_types as PT[];
const typeNames = types.map((t) => t.name);
const verbs = pack.link_types as { name: string; inverse?: string; temporal?: string }[];
const verbNames = verbs.map((l) => l.name);

describe('mobrain-core manifest', () => {
  test('identity', () => {
    expect(pack.name).toBe('mobrain-core');
    expect(pack.version).toBe('1.0.0');
    expect(pack.api_version).toBe('gbrain-schema-pack-v1');
    // A MISSING extends inherits gbrain-base (gbrain fact 3); core must say null.
    expect('extends' in pack && pack.extends === null).toBe(true);
    expect(pack.borrow_from).toEqual([]);
  });

  test('12 types in prefix-priority order', () => {
    expect(typeNames).toEqual([
      'person', 'company', 'meeting', 'conversation', 'event', 'project',
      'concept', 'note', 'source', 'atom', 'synthesis', 'extract_receipt',
    ]);
  });

  test('has every type gbrain writes or falls back to', () => {
    for (const n of ['concept', 'note', 'atom', 'synthesis', 'extract_receipt', 'conversation', 'event',
      'meeting', 'source', 'person', 'company']) {
      expect(typeNames).toContain(n);
    }
  });

  test('project is in core; decision is not', () => {
    expect(typeNames).toContain('project');
    expect(typeNames).not.toContain('decision');
  });

  test('10 verbs with their inverses and lifetimes', () => {
    expect(verbNames).toEqual([
      'relates_to', 'mentions', 'discusses', 'part_of', 'member_of',
      'attended', 'created_by', 'owned_by', 'derived_from', 'supersedes',
    ]);
    const by = Object.fromEntries(verbs.map((v) => [v.name, v]));
    expect(by.relates_to!.inverse).toBe('relates_to');
    expect([by.part_of!.inverse, by.part_of!.temporal]).toEqual(['has_part', 'state']);
    expect([by.member_of!.inverse, by.member_of!.temporal]).toEqual(['has_member', 'state']);
    expect([by.attended!.inverse, by.attended!.temporal]).toEqual(['attended_by', 'event']);
    expect([by.created_by!.inverse, by.created_by!.temporal]).toEqual(['created', 'event']);
    expect([by.owned_by!.inverse, by.owned_by!.temporal]).toEqual(['owns', 'state']);
    expect(by.supersedes!.inverse).toBe('superseded_by');
  });

  test('atom keeps its three subtypes', () => {
    const atom = types.find((t) => t.name === 'atom') as PT & { subtypes: { name: string }[] };
    expect(atom.subtypes.map((s) => s.name)).toEqual(['extraction', 'manual', 'lore']);
  });

  test('every frontmatter link names a declared type and verb', () => {
    for (const f of pack.frontmatter_links as { page_type: string; link_type: string }[]) {
      expect(typeNames).toContain(f.page_type);
      expect(verbNames).toContain(f.link_type);
    }
  });

  test('event attendees are not mapped: gbrain stores them event -> person, the reverse of meetings (probe 6)', () => {
    const fm = pack.frontmatter_links as { page_type: string; fields: string[] }[];
    expect(fm.some((f) => f.page_type === 'event' && f.fields.includes('attendees'))).toBe(false);
    expect(fm.some((f) => f.page_type === 'meeting' && f.fields.includes('attendees'))).toBe(true);
  });

  test('person company fields map to member_of, not the hardcoded works_at', () => {
    const f = (pack.frontmatter_links as { page_type: string; fields: string[]; link_type: string }[])
      .find((x) => x.page_type === 'person')!;
    expect(f.link_type).toBe('member_of');
    expect(f.fields).toEqual(['company', 'companies', 'organization']);
  });

  test('filing rules cover exactly types 1-9, pointing at their primary folder', () => {
    const rules = pack.filing_rules as { kind: string; directory: string }[];
    expect(rules.map((r) => r.kind)).toEqual(typeNames.slice(0, 9));
    for (const r of rules) expect(types.find((x) => x.name === r.kind)!.path_prefixes[0]).toBe(r.directory);
  });

  test('only person and company are enrichable and expert-routed', () => {
    expect((pack.enrichable_types as { type: string }[]).map((e) => e.type)).toEqual(['person', 'company']);
    expect(types.filter((t) => t.expert_routing).map((t) => t.name)).toEqual(['person', 'company']);
  });

  test('declares no investor verb', () => {
    for (const v of ['works_at', 'founded', 'invested_in', 'advises', 'led_round', 'yc_partner']) {
      expect(verbNames).not.toContain(v);
    }
  });

  test('takes kinds are gbrain\'s default', () => {
    expect(pack.takes_kinds).toEqual(['fact', 'take', 'bet', 'hunch']);
  });
});
