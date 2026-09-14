import { test, expect, describe } from 'bun:test';
import { diffCapability, toolNames, parseGbrainVersion } from '../../src/contracts/capability.ts';
import type { CapabilitySnapshot } from '../../src/contracts/capability.ts';

const base: CapabilitySnapshot = {
  gbrainVersion: '0.50.0.0',
  capturedAt: '2026-09-14T00:00:00.000Z',
  tools: [{ name: 'search' }, { name: 'put_page' }],
  wellKnown: {
    profiles: { 'memory-reader': {} },
    adapters: [
      { id: 'claude-code', label: 'Claude Code', connection: 'claude-json', modes: ['http'] },
      { id: 'codex', label: 'Codex', connection: 'codex-toml', modes: ['http'] },
    ],
  },
  schemaPacks: ['gbrain-base-v2'],
};

describe('toolNames', () => {
  test('reads names from an array catalog', () => {
    expect(toolNames([{ name: 'a' }, { name: 'b' }])).toEqual(['a', 'b']);
  });
  test('reads keys from an object catalog', () => {
    expect(toolNames({ a: {}, b: {} })).toEqual(['a', 'b']);
  });
  test('returns empty for an unusable catalog', () => {
    expect(toolNames(null)).toEqual([]);
  });
});

describe('diffCapability', () => {
  test('reports no drift against itself', () => {
    const d = diffCapability(base, base);
    expect(d).toEqual({
      versionChanged: false, toolsAdded: [], toolsRemoved: [],
      adaptersAdded: [], adaptersRemoved: [], profilesChanged: false,
    });
  });

  // The whole point of G4's snapshot half: upstream additions must SURFACE,
  // not break us. An added tool is drift to report, never a failure.
  test('detects an added tool', () => {
    const after = { ...base, tools: [...(base.tools as any[]), { name: 'takes_add' }] };
    expect(diffCapability(base, after).toolsAdded).toEqual(['takes_add']);
  });

  test('detects a removed tool', () => {
    const after = { ...base, tools: [{ name: 'search' }] };
    expect(diffCapability(base, after).toolsRemoved).toEqual(['put_page']);
  });

  test('detects an added harness adapter', () => {
    const after = {
      ...base,
      wellKnown: {
        ...base.wellKnown!,
        adapters: [...base.wellKnown!.adapters,
          { id: 'hermes', label: 'Hermes', connection: 'manual', modes: ['http'] }],
      },
    };
    expect(diffCapability(base, after).adaptersAdded).toEqual(['hermes']);
  });

  test('detects a version change', () => {
    expect(diffCapability(base, { ...base, gbrainVersion: '0.51.0.0' }).versionChanged).toBe(true);
  });

  test('detects a changed profile set', () => {
    const after = {
      ...base,
      wellKnown: { ...base.wellKnown!, profiles: { 'memory-reader': {}, operator: {} } },
    };
    expect(diffCapability(base, after).profilesChanged).toBe(true);
  });
});

describe('parseGbrainVersion', () => {
  test('extracts the version from the real "gbrain X.Y.Z.W" shape', () => {
    expect(parseGbrainVersion('gbrain 0.50.0.0')).toBe('0.50.0.0');
  });

  test('accepts a bare version with no leading label', () => {
    expect(parseGbrainVersion('0.50.0.0')).toBe('0.50.0.0');
  });

  test('tolerates trailing newline and surrounding whitespace', () => {
    expect(parseGbrainVersion('gbrain 0.50.0.0\n')).toBe('0.50.0.0');
    expect(parseGbrainVersion('  gbrain 0.50.0.0  \n')).toBe('0.50.0.0');
  });

  test('takes the last non-empty line of multi-line output', () => {
    expect(parseGbrainVersion('Checking for updates...\n\ngbrain 0.50.0.0\n')).toBe('0.50.0.0');
  });
});
