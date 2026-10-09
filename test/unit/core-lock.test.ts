// test/unit/core-lock.test.ts
import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import core from '../../src/ops/packs/mobrain-core.json';
import personal from '../../src/ops/packs/mobrain-personal.json';
import {
  CORE_MANIFEST, chainReachesCore, coreProjection, ownViolations, resolvedViolations, type Manifest,
} from '../../src/control/coreLock.ts';

const clean = (extra: Manifest = {}): Manifest => ({
  extends: 'mobrain-core', page_types: [{ name: 'contract', primitive: 'media', path_prefixes: ['contracts/'] }],
  link_types: [{ name: 'governs' }], ...extra,
});
const rules = (m: Manifest, opts?: { managed?: boolean }) => ownViolations(m, CORE_MANIFEST, opts).map((v) => v.rule);

describe('ownViolations (L2–L4)', () => {
  test('a clean user pack passes', () => expect(rules(clean())).toEqual([]));
  test('Personal 2.0.0 passes', () => expect(rules(personal as Manifest, { managed: true })).toEqual([]));

  test('L2: a redeclared person', () => {
    const v = ownViolations(clean({ page_types: [{ name: 'person', primitive: 'entity' }] }));
    expect(v.map((x) => x.rule)).toEqual(['L2']);
    expect(v[0]!.message).toBe("The type person comes from mobrain-core and can't be changed. Add a new type instead.");
  });
  test('L2: a redeclared part_of and a redeclared has_part', () => {
    expect(rules(clean({ link_types: [{ name: 'part_of' }] }))).toEqual(['L2']);
    expect(rules(clean({ link_types: [{ name: 'contains_x', inverse: 'has_part' }] }))).toEqual(['L2']);
  });
  test('L3: child maps a pair core maps', () => {
    expect(rules(clean({ frontmatter_links: [{ page_type: 'person', fields: ['company'], link_type: 'works_at' }] }))).toEqual(['L3']);
  });
  test('L3: a child filing rule or enrichment for a core type', () => {
    expect(rules(clean({ filing_rules: [{ kind: 'note', directory: 'n/' }] }))).toEqual(['L3']);
    expect(rules(clean({ enrichable_types: [{ type: 'person' }] }))).toEqual(['L3']);
  });
  test('L4: borrow_from is refused for user packs, allowed for managed ones', () => {
    expect(rules(clean({ borrow_from: ['company-brain'] }))).toEqual(['L4']);
    expect(rules(clean({ borrow_from: ['company-brain'] }), { managed: true })).toEqual([]);
  });
});

describe('resolvedViolations (L5)', () => {
  const resolved = (): Manifest => JSON.parse(JSON.stringify(core));
  test('core resolves to itself', () => expect(resolvedViolations(resolved())).toEqual([]));
  test('core plus a child delta passes', () => {
    const m = resolved();
    m.page_types = [...personal.page_types, ...m.page_types!];
    expect(resolvedViolations(m)).toEqual([]);
  });
  test('a missing type, a changed type and a changed verb are all caught', () => {
    const m = resolved();
    m.page_types = m.page_types!.filter((t) => t.name !== 'note');
    m.page_types!.find((t) => t.name === 'person')!.extractable = false;
    m.link_types!.find((l) => l.name === 'part_of')!.temporal = 'event';
    const v = resolvedViolations(m);
    expect(v).toHaveLength(3);
    expect(new Set(v.map((x) => x.rule))).toEqual(new Set(['L5']));
  });
  test('a dropped frontmatter link, filing rule or enrichment is caught', () => {
    const m = resolved();
    m.frontmatter_links = [];
    m.filing_rules = [];
    m.enrichable_types = [];
    expect(resolvedViolations(m).length).toBe(6 + 9 + 2);
  });
  test('projection ignores alias order and non-compared fields', () => {
    const m = resolved();
    m.page_types!.find((t) => t.name === 'atom')!.aliases!.reverse();
    (m.page_types![0] as any).description = 'x';
    expect(coreProjection(m)).toEqual(coreProjection(core as Manifest));
  });
});

describe('chainReachesCore (L1)', () => {
  const world: Record<string, Manifest> = {
    'mobrain-core': { extends: null },
    'mobrain-personal': { extends: 'mobrain-core' },
    'my-personal': { extends: 'mobrain-personal' },
    'gbrain-base-v2': { extends: 'gbrain-base' },
    'gbrain-base': { extends: null },
    standalone: { extends: null },
    a: { extends: 'b' }, b: { extends: 'a' },
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`d${i}`, { extends: i === 9 ? 'mobrain-core' : `d${i + 1}` }])),
  };
  const read = async (n: string) => world[n] ?? null;
  test('reaches core', async () => {
    expect((await chainReachesCore('my-personal', read)).ok).toBe(true);
    expect((await chainReachesCore('mobrain-core', read)).ok).toBe(true);
  });
  test('ends at gbrain-base-v2', async () => expect((await chainReachesCore('gbrain-base-v2', read)).ok).toBe(false));
  test('ends at null', async () => expect((await chainReachesCore('standalone', read)).ok).toBe(false));
  test('a cycle', async () => {
    const r = await chainReachesCore('a', read);
    expect(r.ok === false && r.reason).toContain('circular');
  });
  test('depth: core at 8 hops passes, at 9 fails', async () => {
    expect((await chainReachesCore('d2', read)).ok).toBe(true);
    const r = await chainReachesCore('d1', read);
    expect(r.ok === false && r.reason).toContain('longer than 8');
  });
  test('an uninstalled parent', async () => {
    const r = await chainReachesCore('x', async (n) => (n === 'x' ? { extends: 'ghost' } : null));
    expect(r.ok === false && r.reason).toContain('ghost');
  });
  test('a missing extends means gbrain-base', async () => {
    expect((await chainReachesCore('m', async (n) => (n === 'm' ? {} : world[n] ?? null))).ok).toBe(false);
  });
});

describe('the designer skill examples obey the lock', () => {
  for (const f of ['legal-ops', 'research-lab']) {
    test(f, () => {
      const ex = JSON.parse(readFileSync(new URL(`../../skills/mobrain-schema-designer/examples/${f}.json`, import.meta.url), 'utf8'));
      expect(ex.extends).toBe('mobrain-core');
      const m: Manifest = {
        extends: ex.extends,
        page_types: ex.pageTypes.map((t: any) => ({ name: t.name })),
        link_types: ex.linkVerbs.map((l: any) => ({ name: l.name, inverse: l.inverse })),
      };
      expect(ownViolations(m)).toEqual([]);
    });
  }
});
