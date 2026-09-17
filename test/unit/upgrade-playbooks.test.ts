import { test, expect, describe } from 'bun:test';
import {
  PLAYBOOKS, RELEASED_VERSIONS, cmpVersion, playbooksFor,
} from '../../src/upgrade/playbooks/index.ts';

const versionsOf = (specs: readonly { version: string }[]) => specs.map((s) => s.version);

describe('version ordering', () => {
  test('compares component-wise, not lexically', () => {
    expect(cmpVersion('0.50.2.0', '0.50.10.0')).toBe(-1);
    expect(cmpVersion('0.50.5.0', '0.50.5.0')).toBe(0);
    expect(cmpVersion('0.51.0.0', '0.50.99.0')).toBe(1);
  });

  test('a moving tag is not a version', () => {
    expect(() => cmpVersion('latest-stable', '0.50.5.0')).toThrow('not a four-part version');
  });
});

describe('the released-version registry', () => {
  test('v0.50.3.0 does not exist and is not listed anywhere', () => {
    expect(RELEASED_VERSIONS.map((r) => r.version)).not.toContain('0.50.3.0');
    expect(versionsOf(PLAYBOOKS)).not.toContain('0.50.3.0');
  });

  test('every released version carries the evidence that established it', () => {
    for (const row of RELEASED_VERSIONS) {
      expect(row.evidence.length).toBeGreaterThan(20);
    }
  });

  test('RELEASED_VERSIONS is sorted ascending and has no duplicates', () => {
    const vs = RELEASED_VERSIONS.map((r) => r.version);
    expect(vs).toEqual([...vs].sort(cmpVersion));
    expect(new Set(vs).size).toBe(vs.length);
  });

  test('every PLAYBOOKS entry names a released version exactly once', () => {
    const released = new Set(RELEASED_VERSIONS.map((r) => r.version));
    const seen = new Set<string>();
    for (const spec of PLAYBOOKS) {
      expect(released.has(spec.version)).toBe(true);
      expect(seen.has(spec.version)).toBe(false);
      seen.add(spec.version);
    }
  });

  test('every spec either has steps or carries non-empty evidence — there is no third kind', () => {
    for (const spec of PLAYBOOKS) {
      if ('noPlaybookRequired' in spec && spec.noPlaybookRequired) {
        expect(spec.evidence.trim().length).toBeGreaterThan(20);
        expect('steps' in spec).toBe(false);
        continue;
      }
      expect(Array.isArray(spec.steps)).toBe(true);
      expect(Array.isArray(spec.checklist)).toBe(true);
      expect(spec.upstreamSkill.path).toMatch(/^skills\/migrations\/v[0-9.]+\.md$/);
      // The digest of the exact file that was read. A placeholder fails here.
      expect(spec.upstreamSkill.sha256).toMatch(/^[0-9a-f]{64}$/);
      for (const step of spec.steps) expect(typeof step.run).toBe('function');
      for (const item of spec.checklist) {
        expect(item.key).toMatch(/^[a-z0-9][a-z0-9-]{2,62}$/);
        expect(item.why.trim().length).toBeGreaterThan(20);
      }
    }
  });
});

describe('playbooksFor', () => {
  test('returns the four real versions of this delta, in ascending order', () => {
    const specs = playbooksFor('0.50.0.0', '0.50.5.0');
    expect(versionsOf(specs)).toEqual(['0.50.1.0', '0.50.2.0', '0.50.4.0', '0.50.5.0']);
  });

  test('0.50.2.0 is the only version in the delta that carries a playbook', () => {
    const withSteps = playbooksFor('0.50.0.0', '0.50.5.0')
      .filter((s) => !('noPlaybookRequired' in s && s.noPlaybookRequired));
    expect(versionsOf(withSteps)).toEqual(['0.50.2.0']);
  });

  test('the interval is half-open: the starting version is never re-applied', () => {
    expect(versionsOf(playbooksFor('0.50.2.0', '0.50.4.0'))).toEqual(['0.50.4.0']);
  });

  test('throws when a version in range has no entry at all', () => {
    // 0.49.0.0 is a real upstream release with a real skill file, deliberately
    // absent from our registry: we never ran it, so we can claim nothing.
    expect(() => playbooksFor('0.48.0.0', '0.50.5.0'))
      .toThrow('no playbook entry for 0.49.0.0');
  });

  test('throws on an unknown target rather than returning an empty plan', () => {
    expect(() => playbooksFor('0.50.0.0', '0.50.9.0'))
      .toThrow('unknown target version 0.50.9.0');
  });

  test('throws when the target is not ahead of the current version', () => {
    expect(() => playbooksFor('0.50.5.0', '0.50.5.0')).toThrow('is not ahead of');
    expect(() => playbooksFor('0.50.5.0', '0.50.2.0')).toThrow('is not ahead of');
  });
});
