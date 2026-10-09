// test/unit/mobrain-pack.test.ts
import { test, expect, describe } from 'bun:test';
import pack from '../../src/ops/packs/mobrain-personal.json';
import core from '../../src/ops/packs/mobrain-core.json';
import { ownViolations, type Manifest } from '../../src/control/coreLock.ts';

const typeNames = (pack.page_types as { name: string }[]).map((t) => t.name);
const verbNames = (pack.link_types as { name: string }[]).map((l) => l.name);
const coreTypes = (core.page_types as { name: string }[]).map((t) => t.name);
const coreVerbs = (core.link_types as { name: string; inverse?: string }[]).flatMap((l) => [l.name, l.inverse ?? '']).filter(Boolean);

describe('mobrain-personal manifest (a delta on mobrain-core)', () => {
  test('identity', () => {
    expect(pack.name).toBe('mobrain-personal');
    expect(pack.version).toBe('2.0.0');
    expect(pack.api_version).toBe('gbrain-schema-pack-v1');
    expect(pack.extends).toBe('mobrain-core');
  });

  test('adds only the personal types', () => {
    expect(typeNames).toEqual(['journal', 'area', 'goal', 'decision', 'idea', 'writing', 'health_record', 'finance_record']);
    expect((pack.page_types as { name: string; primitive: string }[]).find((t) => t.name === 'decision')!.primitive).toBe('annotation');
  });

  test('no core name appears among its own types, verbs or inverses (L2)', () => {
    for (const n of typeNames) expect(coreTypes).not.toContain(n);
    for (const l of pack.link_types as { name: string; inverse?: string }[]) {
      expect(coreVerbs).not.toContain(l.name);
      if (l.inverse) expect(coreVerbs).not.toContain(l.inverse);
    }
  });

  test('the domain verbs moved here from core', () => {
    expect(verbNames).toEqual([
      'works_at', 'founded', 'advises', 'introduced', 'belongs_to', 'serves',
      'contributes_to', 'affects', 'decided_in', 'provider_for', 'owes_to', 'awaiting_reply_from',
    ]);
    for (const dropped of ['authored', 'sourced_from', 'redirects_to']) expect(verbNames).not.toContain(dropped);
  });

  test('no (page_type, field) pair overlaps core (L3)', () => {
    const pairs = (m: typeof pack) =>
      (m.frontmatter_links as { page_type: string; fields: string[] }[]).flatMap((f) => f.fields.map((x) => `${f.page_type}.${x}`));
    const coreSet = new Set(pairs(core as unknown as typeof pack));
    for (const p of pairs(pack)) expect(coreSet.has(p)).toBe(false);
  });

  test('its own frontmatter links point at types and verbs declared in Personal ∪ core', () => {
    const types = [...typeNames, ...coreTypes];
    const verbs = [...verbNames, ...(core.link_types as { name: string }[]).map((l) => l.name)];
    for (const f of pack.frontmatter_links as { page_type: string; link_type: string }[]) {
      expect(types).toContain(f.page_type);
      expect(verbs).toContain(f.link_type);
    }
  });

  test('one filing rule per Personal type, pointing at its primary folder', () => {
    const rules = pack.filing_rules as { kind: string; directory: string }[];
    expect(rules.map((r) => r.kind)).toEqual(typeNames);
    for (const r of rules) {
      const t = (pack.page_types as { name: string; path_prefixes: string[] }[]).find((x) => x.name === r.kind)!;
      expect(t.path_prefixes[0]).toBe(r.directory);
    }
  });

  test('passes the core lock', () => {
    expect(ownViolations(pack as Manifest, core as Manifest, { managed: true })).toEqual([]);
  });
});
