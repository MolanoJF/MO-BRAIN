import { test, expect, describe } from 'bun:test';
import { compareDigests, compareDoctor, type StateDigest } from '../../src/upgrade/digest.ts';

const part = (name: string, sha256: string, items = 1) => ({ name, sha256, items, scope: 'test' });

const base: StateDigest = {
  takenAt: '2026-09-16T00:00:00.000Z',
  gbrainVersion: '0.50.0.0',
  configKeys: ['embedding_model', 'self_upgrade.mode'],
  pages: 3,
  sources: [{ id: 'handbook', treeHash: 'f'.repeat(40), files: 3 }],
  controlRowCounts: { connections: 1, users: 1 },
  filePlane: part('filePlane', 'f'.repeat(64)),
  parts: [
    part('pin', 'a'.repeat(64)),
    part('sources', 'b'.repeat(64), 3),
    part('repos', 'c'.repeat(64), 3),
    part('configKeys', 'd'.repeat(64), 2),
    part('controlRows', 'e'.repeat(64), 14),
  ],
};

const withPart = (name: string, sha256: string): StateDigest => ({
  ...base, parts: base.parts.map((p) => (p.name === name ? { ...p, sha256 } : p)),
});

describe('compareDigests', () => {
  test('identical digests match', () => {
    const r = compareDigests(base, structuredClone(base));
    expect(r.equal).toBe(true);
    expect(r.differing).toEqual([]);
    expect(r.onlyInA).toEqual([]);
    expect(r.onlyInB).toEqual([]);
  });

  test('a digest taken at a different instant still matches — time is not state', () => {
    const later = { ...structuredClone(base), takenAt: '2026-09-16T04:00:00.000Z' };
    expect(compareDigests(base, later).equal).toBe(true);
  });

  test('one changed part is reported by name, and nothing else is', () => {
    const r = compareDigests(base, withPart('repos', 'f'.repeat(64)));
    expect(r.equal).toBe(false);
    expect(r.differing).toHaveLength(1);
    expect(r.differing[0]!.part).toBe('repos');
    expect(r.differing[0]!.a).toBe('c'.repeat(64));
    expect(r.differing[0]!.b).toBe('f'.repeat(64));
  });

  test('a failure says WHAT differs, not just that something did', () => {
    const two = { ...withPart('repos', 'f'.repeat(64)) };
    two.parts = two.parts.map((p) => (p.name === 'pin' ? { ...p, sha256: '9'.repeat(64) } : p));
    expect(compareDigests(base, two).differing.map((d) => d.part).sort())
      .toEqual(['pin', 'repos']);
  });

  test('a part present on one side only is reported as such, never as equal', () => {
    const fewer = { ...base, parts: base.parts.filter((p) => p.name !== 'controlRows') };
    const r = compareDigests(base, fewer);
    expect(r.equal).toBe(false);
    expect(r.onlyInA).toEqual(['controlRows']);
    expect(r.onlyInB).toEqual([]);
    expect(r.differing).toEqual([]);
  });

  test('the pin is a part, so a rollback that forgot the pin cannot pass', () => {
    expect(compareDigests(base, withPart('pin', '1'.repeat(64))).equal).toBe(false);
  });
});

const check = (name: string, status: 'ok' | 'warn' | 'fail') => ({ name, status, message: '' });
const report = (checks: ReturnType<typeof check>[]) => ({
  gbrainVersion: '0.50.0.0', capturedAt: '2026-09-16T00:00:00.000Z',
  status: 'healthy', healthScore: 100, categoryScores: {}, checks,
});

describe('compareDoctor', () => {
  test('an ok check that is now warn is a regression', () => {
    const r = compareDoctor(
      report([check('schema_version', 'ok'), check('embeddings', 'ok')]),
      report([check('schema_version', 'ok'), check('embeddings', 'warn')]),
    );
    expect(r.regressed.map((c) => c.name)).toEqual(['embeddings']);
    expect(r.schemaVersionOk).toBe(true);
  });

  test('a check that did not exist in the baseline is news, not a regression (D5)', () => {
    const r = compareDoctor(
      report([check('schema_version', 'ok')]),
      report([check('schema_version', 'ok'), check('oauth_scope_ceiling', 'warn')]),
    );
    expect(r.regressed).toEqual([]);
    expect(r.newChecks.map((c) => c.name)).toEqual(['oauth_scope_ceiling']);
  });

  test('a check that improved is reported as resolved', () => {
    const r = compareDoctor(
      report([check('schema_version', 'ok'), check('provider_sunset', 'fail')]),
      report([check('schema_version', 'ok'), check('provider_sunset', 'ok')]),
    );
    expect(r.resolved.map((c) => c.name)).toEqual(['provider_sunset']);
  });

  test('a warn on schema_version fails the gate even though doctor exits 0 (U7)', () => {
    const r = compareDoctor(
      report([check('schema_version', 'ok')]),
      report([check('schema_version', 'warn')]),
    );
    expect(r.schemaVersionOk).toBe(false);
  });

  test('a schema_version check that vanished is not a pass', () => {
    const r = compareDoctor(report([check('schema_version', 'ok')]), report([check('other', 'ok')]));
    expect(r.schemaVersionOk).toBe(false);
  });
});
