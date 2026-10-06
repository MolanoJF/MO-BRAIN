// test/unit/mobrain-pack.test.ts
import { test, expect, describe } from 'bun:test';
import pack from '../../src/ops/packs/mobrain-personal.json';

type PT = { name: string; primitive: string; path_prefixes: string[]; aliases: string[]; extractable: boolean; expert_routing: boolean };
const types = pack.page_types as PT[];
const typeNames = types.map((t) => t.name);
const verbNames = (pack.link_types as { name: string }[]).map((l) => l.name);

describe('mobrain-personal manifest (spec §3)', () => {
  test('identity', () => {
    expect(pack.name).toBe('mobrain-personal');
    expect(pack.version).toBe('1.0.0');
    expect(pack.api_version).toBe('gbrain-schema-pack-v1');
    // A MISSING extends inherits gbrain-base (S7); it must be an explicit null.
    expect('extends' in pack && pack.extends === null).toBe(true);
  });

  test('17 user types + 3 system types', () => {
    expect(typeNames).toEqual([
      'person', 'company', 'meeting', 'conversation', 'event', 'journal',
      'area', 'goal', 'project', 'decision', 'idea', 'concept', 'note',
      'source', 'writing', 'health_record', 'finance_record',
      'atom', 'synthesis', 'extract_receipt',
    ]);
  });

  test('keeps every type name gbrain hardcodes (spec P3)', () => {
    for (const n of ['person', 'company', 'meeting', 'note', 'concept', 'atom', 'synthesis', 'extract_receipt']) {
      expect(typeNames).toContain(n);
    }
  });

  test('drops the investor-shaped types', () => {
    for (const n of ['deal', 'tweet', 'yc', 'social-digest', 'slack', 'email', 'civic', 'diary', 'media']) {
      expect(typeNames).not.toContain(n);
    }
    for (const v of ['invested_in', 'led_round', 'yc_partner', 'partner_of']) expect(verbNames).not.toContain(v);
  });

  test('21 link verbs', () => {
    expect(verbNames).toHaveLength(21);
    expect(new Set(verbNames).size).toBe(21);
  });

  test('every frontmatter link names a declared type and verb', () => {
    for (const f of pack.frontmatter_links as { page_type: string; link_type: string }[]) {
      expect(typeNames).toContain(f.page_type);
      expect(verbNames).toContain(f.link_type);
    }
  });

  test('one filing rule per user type, pointing at its primary folder', () => {
    const rules = pack.filing_rules as { kind: string; directory: string }[];
    expect(rules).toHaveLength(17);
    for (const r of rules) {
      const t = types.find((x) => x.name === r.kind)!;
      expect(t.path_prefixes[0]).toBe(r.directory);
    }
  });

  test('only person and company are enrichable and expert-routed', () => {
    expect((pack.enrichable_types as { type: string }[]).map((e) => e.type)).toEqual(['person', 'company']);
    expect(types.filter((t) => t.expert_routing).map((t) => t.name)).toEqual(['person', 'company']);
  });
});
