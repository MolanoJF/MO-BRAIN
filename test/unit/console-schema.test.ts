import { test, expect, describe } from 'bun:test';
import {
  activeSummary, divergenceWarning, canApply, syncSummary, ADDITIVE_NOTICE,
  packSummary, pageTypeLabel, inheritanceNote,
} from '../../src/console/pages/Schema.tsx';
import type { PackDetail, PackPageType } from '../../src/console/api.ts';

const ACTIVE = {
  pack: 'gbrain-base-v2', version: '1.2.0', source: 'home-config',
  identity: 'gbrain-base-v2@1.2.0+1a2aee67', pageTypes: 19, linkVerbs: 17,
};

describe('the active summary', () => {
  test('names the pack and the tier it was resolved from', () => {
    const s = activeSummary(ACTIVE);
    expect(s).toContain('gbrain-base-v2');
    expect(s).toContain('1.2.0');
    expect(s).toContain('home-config');
  });

  test('an unresolvable pack never reads as a healthy default', () => {
    const s = activeSummary({ pack: null, version: null, source: null, identity: null, pageTypes: null, linkVerbs: null });
    expect(s).toMatch(/could not|unknown|no pack/i);
    expect(s).not.toMatch(/gbrain-base/);
  });
});

describe('divergence — honesty rule 5', () => {
  test('a matching pack produces no warning', () => {
    expect(divergenceWarning({ stored: 'gbrain-base-v2', active: ACTIVE, diverged: false })).toBeNull();
  });

  test('a db-config tier names the tier and says it outranks this page', () => {
    // MEASURED trap: tier 4 outranks the tier 6 this page writes, and
    // `gbrain schema use` reports success while changing nothing.
    const w = divergenceWarning({
      stored: 'hr-policies',
      active: { ...ACTIVE, pack: 'gbrain-base-v2', source: 'db-config' },
      diverged: true,
    });
    expect(w).toContain('db-config');
    expect(w).toContain('hr-policies');
    expect(w).toMatch(/outranks/i);
  });

  test('a brain that never chose a pack is not diverged', () => {
    expect(divergenceWarning({ stored: null, active: ACTIVE, diverged: false })).toBeNull();
  });
});

describe('the apply gate', () => {
  const clean = { ok: true, errors: [], warnings: [] };
  const preview = { apply: false, pack_identity: null, per_prefix: [], total_would_apply: 0, total_applied: 0 };

  test('apply needs a clean lint AND a seen preview', () => {
    expect(canApply({ busy: false, pack: 'hr-policies', lint: clean, preview })).toBe(true);
  });

  test('no preview means no apply', () => {
    expect(canApply({ busy: false, pack: 'hr-policies', lint: clean, preview: null })).toBe(false);
  });

  test('a lint with errors blocks apply even with a preview', () => {
    const bad = { ok: false, errors: [{ rule: 'duplicate_type', message: 'x' }], warnings: [] };
    expect(canApply({ busy: false, pack: 'hr-policies', lint: bad, preview })).toBe(false);
  });

  test('warnings alone do not block apply', () => {
    // gbrain-base-v2 itself lints with warnings; blocking on those would make
    // the shipped default unselectable.
    const warned = { ok: true, errors: [], warnings: [{ rule: 'alias_references_undeclared_type', message: 'x' }] };
    expect(canApply({ busy: false, pack: 'hr-policies', lint: warned, preview })).toBe(true);
  });

  test('a busy page cannot apply', () => {
    expect(canApply({ busy: true, pack: 'hr-policies', lint: clean, preview })).toBe(false);
  });

  test('no pack selected cannot apply', () => {
    expect(canApply({ busy: false, pack: '', lint: clean, preview })).toBe(false);
  });
});

describe('the sync summary', () => {
  test('zero matches is explained, not reported as a failure', () => {
    // The normal result on a brain whose pages are already typed. An admin who
    // reads "0 applied" as breakage will go looking for a bug that is not there.
    const s = syncSummary({
      apply: false, pack_identity: 'p@1.0.0+aa',
      per_prefix: [{ type: 'policy', prefix: 'policies/', would_apply: 0, applied: 0, dead_prefix: true, sample_slugs: [] }],
      total_would_apply: 0, total_applied: 0,
    });
    expect(s).toMatch(/no untyped pages/i);
    expect(s).not.toMatch(/error|failed/i);
  });

  test('a real backfill reports the count', () => {
    const s = syncSummary({
      apply: true, pack_identity: 'p@1.0.0+aa',
      per_prefix: [{ type: 'policy', prefix: 'policies/', would_apply: 4, applied: 4, dead_prefix: false, sample_slugs: [] }],
      total_would_apply: 4, total_applied: 4,
    });
    expect(s).toContain('4');
  });
});

test('the page states plainly that a switch does not re-type existing pages', () => {
  // The single most important sentence on this page: `schema sync` only fills
  // a blank type, so pages typed under the old pack keep their old type.
  expect(ADDITIVE_NOTICE).toMatch(/does not re-type/i);
  expect(ADDITIVE_NOTICE).toMatch(/keep the type/i);
});

/**
 * The pack browser. These are the counts and labels an admin decides from, so
 * they are pure functions the test can pin without a DOM.
 */

const pageType = (name: string, over: Partial<PackPageType> = {}): PackPageType => ({
  name,
  primitive: 'concept',
  pathPrefixes: [],
  aliases: [],
  extractable: true,
  expertRouting: false,
  ...over,
});

const detail = (over: Partial<PackDetail> = {}): PackDetail => ({
  name: 'gbrain-base-v2',
  version: '1.2.0',
  description: null,
  extends: null,
  bundled: false,
  pageTypes: [],
  linkVerbs: [],
  linkTypes: [],
  filingRules: [],
  takesKinds: [],
  error: null,
  ...over,
});

describe('the pack summary', () => {
  test('reports effective page types and link verbs, and the parent when it extends one', () => {
    const s = packSummary(detail({
      name: 'gbrain-investor',
      extends: 'gbrain-base',
      pageTypes: Array.from({ length: 29 }, (_, i) => pageType(`t${i}`)),
      linkVerbs: Array.from({ length: 12 }, (_, i) => `v${i}`),
    }));
    expect(s).toContain('29 page types');
    expect(s).toContain('12 link verbs');
    expect(s).toContain('extends gbrain-base');
  });

  test('a pack that does not extend anything omits the parent clause', () => {
    const s = packSummary(detail({ pageTypes: [pageType('x')], linkVerbs: ['y'] }));
    expect(s).toContain('1 page type');
    expect(s).toContain('1 link verb');
    expect(s).not.toContain('extends');
  });

  test('REGRESSION: gbrain-creator is 27 effective page types, not its raw 1', () => {
    // `gbrain schema show <pack>` prints the UNRESOLVED manifest; gbrain-creator
    // declares 1 there and 27 effective. Serving/rendering the raw number is the
    // false claim Task 1's packOverride seam exists to prevent (S4).
    const creator = detail({
      name: 'gbrain-creator',
      extends: 'gbrain-base',
      pageTypes: Array.from({ length: 27 }, (_, i) => pageType(`t${i}`)),
      linkVerbs: Array.from({ length: 12 }, (_, i) => `v${i}`),
    });
    const s = packSummary(creator);
    expect(s).toContain('27 page types');
    expect(s).not.toContain('1 page type');
  });
});

describe('the page type label', () => {
  test('names the type, its primitive and its path prefixes', () => {
    const label = pageTypeLabel(pageType('thesis', {
      primitive: 'concept', pathPrefixes: ['investing/theses/', 'theses/'],
    }));
    expect(label).toContain('thesis');
    expect(label).toContain('concept');
    expect(label).toContain('investing/theses/');
    expect(label).toContain('theses/');
  });

  test('a type with no primitive or prefixes is just its name', () => {
    expect(pageTypeLabel(pageType('bare', { primitive: '', pathPrefixes: [] }))).toBe('bare');
  });
});

describe('the inheritance note', () => {
  test('an inherited pack is named as the brain default, with the pack', () => {
    const note = inheritanceNote(true, 'gbrain-base-v2');
    expect(note).toMatch(/inherits the brain default/i);
    expect(note).toContain('gbrain-base-v2');
  });

  test('an override is not an inheritance note — the caller must name it as stored', () => {
    expect(inheritanceNote(false, 'gbrain-investor')).toBeNull();
  });

  test('an inherited pack with no resolved name still says it inherits', () => {
    const note = inheritanceNote(true, null);
    expect(note).toMatch(/inherits the brain default/i);
  });
});
