import { test, expect, describe } from 'bun:test';
import {
  clientName,
  compileConnection,
  diffCompiled,
  GRANT_PROFILES,
  type CompiledConnection,
  type GrantProfileId,
  type Warning,
} from '../../src/contracts/compile.ts';
import type { Role } from '../../src/control/rbac.ts';

const WRITE = { sourceId: 'customers', slug: 'customers' };
const READS = [{ sourceId: 'shared' }, { sourceId: 'internal' }];

const ROLES: Role[] = ['viewer', 'member', 'admin', 'owner'];
const UNREACHABLE: GrantProfileId[] = ['operator', 'delegating-agent', 'full'];
const WRITE_CAPABLE: GrantProfileId[] = [
  'memory-writer', 'coding-agent', 'operator', 'delegating-agent', 'full',
];
const ROLE_PROFILE: Record<Role, GrantProfileId> = {
  viewer: 'memory-reader',
  member: 'memory-writer',
  admin: 'coding-agent',
  owner: 'coding-agent',
};

const STANDING_IDS: Warning['id'][] = [
  'read-isolation-per-space',
  'additions-need-new-token',
  'rotation-is-not-revocation',
  'verify-partial-is-not-green',
];

const WRITE_FENCE_AFFECTS = [
  'extract_entities',
  'extract_facts',
  'forget_fact',
  'ontology_propose',
  'sources_add',
  'sources_remove',
  'POST /ingest',
  "put_page automatic fact extraction skipped",
];

const TOKEN_TTL_MIN = 60;
const TOKEN_TTL_MAX = 90 * 24 * 60 * 60; // 7_776_000
const TOKEN_TTL_DEFAULT = 3600;

function compile(
  role: Role = 'member',
  readSpaces: { sourceId: string }[] = READS,
  opts?: {
    boundSlugPrefixes?: string[];
    tokenTtl?: number;
    budgetUsdPerDay?: number;
    privateSpace?: boolean;
  },
  writeSpace: { sourceId: string; slug: string } = WRITE,
): CompiledConnection {
  return compileConnection({ role }, writeSpace, readSpaces, opts);
}

function warningIds(c: CompiledConnection): Warning['id'][] {
  return c.warnings.map((w) => w.id);
}

describe('GRANT_PROFILES', () => {
  test('is exactly the 6 ids from capability.json wellKnown.profiles', () => {
    expect([...GRANT_PROFILES]).toEqual([
      'memory-reader', 'memory-writer', 'coding-agent',
      'operator', 'delegating-agent', 'full',
    ]);
  });
});

describe('clientName', () => {
  const membershipId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  test('is deterministic: same inputs yield the same name', () => {
    expect(clientName(membershipId, 'customers'))
      .toBe(clientName(membershipId, 'customers'));
  });

  test('is bs-<first 8 of membershipId>-<spaceSlug>', () => {
    expect(clientName(membershipId, 'customers')).toBe('bs-a1b2c3d4-customers');
    expect(clientName('abcdefghijklmnop', 'internal')).toBe('bs-abcdefgh-internal');
  });

  test('distinct (membershipId, spaceSlug) pairs produce distinct names', () => {
    const names = new Set([
      clientName('aaaaaaaa-1111', 'customers'),
      clientName('bbbbbbbb-1111', 'customers'),
      clientName('aaaaaaaa-1111', 'internal'),
      clientName('bbbbbbbb-1111', 'internal'),
    ]);
    expect(names.size).toBe(4);
  });

  test('uses only the first 8 characters of membershipId', () => {
    expect(clientName('12345678XXXX', 'shared')).toBe(clientName('12345678YYYY', 'shared'));
  });
});

describe('compileConnection role → profile', () => {
  test('maps each Role onto the V17 profile table', () => {
    for (const role of ROLES) {
      expect(compile(role).profile).toBe(ROLE_PROFILE[role]);
    }
  });

  test('operator, delegating-agent and full are not reachable', () => {
    const reached = new Set(ROLES.map((role) => compile(role).profile));
    for (const id of UNREACHABLE) expect(reached.has(id)).toBe(false);
    expect(GRANT_PROFILES.filter((p) => reached.has(p)).sort())
      .toEqual(['coding-agent', 'memory-reader', 'memory-writer']);
  });

  test('a viewer never compiles to a write-capable profile', () => {
    const profile = compile('viewer').profile;
    expect(profile).toBe('memory-reader');
    expect(WRITE_CAPABLE).not.toContain(profile);
  });
});

describe('compileConnection federatedRead', () => {
  test('the write source never appears in federatedRead', () => {
    const c = compile('member', [
      { sourceId: 'shared' },
      { sourceId: 'customers' },
      { sourceId: 'internal' },
    ]);
    expect(c.sourceId).toBe('customers');
    expect(c.federatedRead).not.toContain('customers');
    expect(c.federatedRead).toEqual(['internal', 'shared']);
  });

  test('is sorted and deduplicated', () => {
    const c = compile('member', [
      { sourceId: 'zebra' },
      { sourceId: 'alpha' },
      { sourceId: 'alpha' },
      { sourceId: 'mid' },
      { sourceId: 'zebra' },
    ]);
    expect(c.federatedRead).toEqual(['alpha', 'mid', 'zebra']);
  });

  test('empty read set yields an empty federatedRead', () => {
    expect(compile('member', []).federatedRead).toEqual([]);
  });

  test('is a copy: mutating the input does not change the result', () => {
    const input = [{ sourceId: 'shared' }, { sourceId: 'internal' }];
    const c = compile('member', input);
    input.push({ sourceId: 'secret' });
    expect(c.federatedRead).toEqual(['internal', 'shared']);
  });
});

describe('compileConnection tokenTtl (V7)', () => {
  test('defaults to 3600', () => {
    expect(compile().tokenTtl).toBe(TOKEN_TTL_DEFAULT);
  });

  test('clamps below 60s up to the floor', () => {
    expect(compile('member', READS, { tokenTtl: 0 }).tokenTtl).toBe(TOKEN_TTL_MIN);
    expect(compile('member', READS, { tokenTtl: 30 }).tokenTtl).toBe(TOKEN_TTL_MIN);
    expect(compile('member', READS, { tokenTtl: -100 }).tokenTtl).toBe(TOKEN_TTL_MIN);
  });

  test('clamps above 90d down to the ceiling', () => {
    expect(compile('member', READS, { tokenTtl: TOKEN_TTL_MAX + 1 }).tokenTtl).toBe(TOKEN_TTL_MAX);
    expect(compile('member', READS, { tokenTtl: 99_999_999 }).tokenTtl).toBe(TOKEN_TTL_MAX);
  });

  test('passes through a value inside the bounds', () => {
    expect(compile('member', READS, { tokenTtl: 60 }).tokenTtl).toBe(60);
    expect(compile('member', READS, { tokenTtl: 300 }).tokenTtl).toBe(300);
    expect(compile('member', READS, { tokenTtl: TOKEN_TTL_MAX }).tokenTtl).toBe(TOKEN_TTL_MAX);
  });
});

describe('compileConnection bound fields', () => {
  test('sourceId is the write Space source', () => {
    expect(compile().sourceId).toBe('customers');
  });

  test('boundSlugPrefixes is null when omitted', () => {
    expect(compile().boundSlugPrefixes).toBeNull();
  });

  test('boundSlugPrefixes is copied from opts when set', () => {
    const prefixes = ['alice-example/', 'bob-example/'];
    const c = compile('member', READS, { boundSlugPrefixes: prefixes });
    expect(c.boundSlugPrefixes).toEqual(['alice-example/', 'bob-example/']);
    prefixes.push('mutated/');
    expect(c.boundSlugPrefixes).toEqual(['alice-example/', 'bob-example/']);
  });

  test('budgetUsdPerDay is null when omitted and passed through when set', () => {
    expect(compile().budgetUsdPerDay).toBeNull();
    expect(compile('member', READS, { budgetUsdPerDay: 12.5 }).budgetUsdPerDay).toBe(12.5);
  });

  test('boundMaxConcurrent is unset (null) — not in compile opts', () => {
    expect(compile().boundMaxConcurrent).toBeNull();
  });

  // Mo-brain Connections are minted at `full`, not the profile's `starter`
  // default; the profile's scopes still bound what is callable.
  test('surface is full for every reachable profile', () => {
    for (const role of ROLES) expect(compile(role).surface).toBe('full');
  });
});

describe('honesty-rule warnings', () => {
  test('standing rules 1, 3, 4, 5 always emit', () => {
    for (const role of ROLES) {
      const ids = warningIds(compile(role));
      for (const id of STANDING_IDS) expect(ids).toContain(id);
    }
  });

  test('write-fence-disables-extraction is absent without a fence', () => {
    expect(warningIds(compile())).not.toContain('write-fence-disables-extraction');
    expect(warningIds(compile('admin'))).not.toContain('write-fence-disables-extraction');
  });

  test('write-fence-disables-extraction emits when boundSlugPrefixes is non-null', () => {
    const c = compile('member', READS, { boundSlugPrefixes: ['alice-example/'] });
    const fence = c.warnings.find((w) => w.id === 'write-fence-disables-extraction');
    expect(fence).toBeDefined();
    expect(fence!.severity).toBe('warn');
    expect(fence!.affects).toEqual(WRITE_FENCE_AFFECTS);
    for (const name of [
      'extract_entities', 'extract_facts', 'forget_fact', 'ontology_propose',
      'sources_add', 'sources_remove', 'POST /ingest',
    ]) {
      expect(fence!.affects).toContain(name);
    }
    expect(fence!.affects.some((a) => a.includes('put_page'))).toBe(true);
  });

  test('an empty boundSlugPrefixes array is still non-null, so the fence warning fires', () => {
    const c = compile('member', READS, { boundSlugPrefixes: [] });
    expect(c.boundSlugPrefixes).toEqual([]);
    expect(warningIds(c)).toContain('write-fence-disables-extraction');
  });

  test('standing warning severities are stable', () => {
    const byId = Object.fromEntries(compile().warnings.map((w) => [w.id, w]));
    expect(byId['read-isolation-per-space']?.severity).toBe('info');
    expect(byId['additions-need-new-token']?.severity).toBe('warn');
    expect(byId['rotation-is-not-revocation']?.severity).toBe('warn');
    expect(byId['verify-partial-is-not-green']?.severity).toBe('warn');
  });

  test('compile is deterministic: same inputs, same warnings', () => {
    expect(compile()).toEqual(compile());
  });
});

describe('compileConnection private-space profile', () => {
  test('a viewer compiling a private space gets memory-writer', () => {
    expect(compile('viewer', READS, { privateSpace: true }).profile).toBe('memory-writer');
  });

  test('a viewer without the flag still gets memory-reader', () => {
    expect(compile('viewer', READS, { privateSpace: false }).profile).toBe('memory-reader');
    expect(compile('viewer').profile).toBe('memory-reader');
  });

  test('every role gets memory-writer on a private space, never the fenced coding-agent', () => {
    for (const role of ['member', 'admin', 'owner'] as const) {
      expect(compile(role, READS, { privateSpace: true }).profile).toBe('memory-writer');
    }
  });

  test('a company space keeps the role mapping', () => {
    expect(compile('admin', READS, { privateSpace: false }).profile).toBe('coding-agent');
    expect(compile('owner').profile).toBe('coding-agent');
  });

  test('a private space never yields memory-reader for any role', () => {
    for (const role of ROLES) {
      expect(compile(role, READS, { privateSpace: true }).profile).not.toBe('memory-reader');
    }
  });
});

describe('diffCompiled', () => {
  const after = compile('member');

  test('null before treats the write source as an addition and requires a new token', () => {
    const d = diffCompiled(null, after);
    expect(d.removals).toEqual([]);
    expect(d.additions).toContain(after.sourceId);
    expect(d.requiresNewToken).toBe(true);
  });

  test('adding a federated-read source is an addition and requires a new token', () => {
    const before = compile('member', [{ sourceId: 'shared' }]);
    const next = compile('member', [{ sourceId: 'shared' }, { sourceId: 'internal' }]);
    const d = diffCompiled(before, next);
    expect(d.additions).toEqual(['internal']);
    expect(d.removals).toEqual([]);
    expect(d.requiresNewToken).toBe(true);
  });

  test('removing a federated-read source is a removal and does not require a new token', () => {
    const before = compile('member', [{ sourceId: 'shared' }, { sourceId: 'internal' }]);
    const next = compile('member', [{ sourceId: 'shared' }]);
    const d = diffCompiled(before, next);
    expect(d.removals).toEqual(['internal']);
    expect(d.additions).toEqual([]);
    expect(d.requiresNewToken).toBe(false);
  });

  test('identical compiles produce an empty diff', () => {
    const d = diffCompiled(after, compile('member'));
    expect(d).toEqual({ removals: [], additions: [], requiresNewToken: false });
  });

  test('additions and removals together require a new token', () => {
    const before = compile('member', [{ sourceId: 'shared' }]);
    const next = compile('member', [{ sourceId: 'internal' }]);
    const d = diffCompiled(before, next);
    expect(d.additions).toEqual(['internal']);
    expect(d.removals).toEqual(['shared']);
    expect(d.requiresNewToken).toBe(true);
  });

  test('requiresNewToken is true iff additions.length > 0', () => {
    const cases: Array<{ before: CompiledConnection | null; after: CompiledConnection }> = [
      { before: null, after },
      { before: after, after },
      { before: compile('member', [{ sourceId: 'shared' }]), after: compile('member', [{ sourceId: 'shared' }, { sourceId: 'internal' }]) },
      { before: compile('member', [{ sourceId: 'shared' }, { sourceId: 'internal' }]), after: compile('member', [{ sourceId: 'shared' }]) },
    ];
    for (const c of cases) {
      const d = diffCompiled(c.before, c.after);
      expect(d.requiresNewToken).toBe(d.additions.length > 0);
    }
  });

  test('additions and removals are sorted', () => {
    const before = compile('member', [{ sourceId: 'mid' }]);
    const next = compile('member', [{ sourceId: 'zebra' }, { sourceId: 'alpha' }]);
    const d = diffCompiled(before, next);
    expect(d.additions).toEqual(['alpha', 'zebra']);
    expect(d.removals).toEqual(['mid']);
  });

  test('widening a write fence is an addition (needs a new token)', () => {
    const before = compile('member', READS, { boundSlugPrefixes: ['alice/'] });
    const next = compile('member', READS, { boundSlugPrefixes: ['alice/', 'bob/'] });
    const d = diffCompiled(before, next);
    expect(d.additions).toContain('prefix:bob/');
    expect(d.requiresNewToken).toBe(true);
  });

  test('narrowing a write fence is a removal (live token picks it up)', () => {
    const before = compile('member', READS, { boundSlugPrefixes: ['alice/', 'bob/'] });
    const next = compile('member', READS, { boundSlugPrefixes: ['alice/'] });
    const d = diffCompiled(before, next);
    expect(d.removals).toContain('prefix:bob/');
    expect(d.additions).toEqual([]);
    expect(d.requiresNewToken).toBe(false);
  });

  test('unfenced → fenced is a narrowing (no new token)', () => {
    const before = compile('member');
    const next = compile('member', READS, { boundSlugPrefixes: ['alice/'] });
    const d = diffCompiled(before, next);
    expect(d.requiresNewToken).toBe(false);
    expect(d.removals.length).toBeGreaterThan(0);
  });

  test('fenced → unfenced is a widening (needs a new token)', () => {
    const before = compile('member', READS, { boundSlugPrefixes: ['alice/'] });
    const next = compile('member');
    const d = diffCompiled(before, next);
    expect(d.requiresNewToken).toBe(true);
    expect(d.additions.length).toBeGreaterThan(0);
  });

  test('promoting viewer → member requires a new token', () => {
    const d = diffCompiled(compile('viewer'), compile('member'));
    expect(d.requiresNewToken).toBe(true);
    expect(d.additions.some((a) => a.includes('memory-writer') || a.includes('write'))).toBe(true);
  });

  test('demoting member → viewer does not require a new token', () => {
    const d = diffCompiled(compile('member'), compile('viewer'));
    expect(d.requiresNewToken).toBe(false);
    expect(d.removals.length).toBeGreaterThan(0);
  });
});
