import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HARVEST_MAP,
  annotateAdapters,
  autoInstall,
  connectionClass,
  wiringSnippet,
  type ConnectionClass,
} from '../../src/control/harness.ts';

const capability = JSON.parse(
  readFileSync(join(import.meta.dir, '../../contracts/v0.50.0.0/capability.json'), 'utf8'),
) as { wellKnown?: { adapters?: Array<{ id: string }> } };

const WELL_KNOWN_IDS = (capability.wellKnown?.adapters ?? []).map((a) => a.id);
const MAP_IDS = Object.keys(HARVEST_MAP);

const EXPECTED: Record<string, ConnectionClass> = {
  'claude-code': 'claude-json',
  codex: 'codex-toml',
  opencode: 'opencode-json',
  openclaw: 'thin-cli',
  'grok-bot': 'thin-cli',
  muse: 'thin-cli',
  'claude-desktop': 'manual',
  'grok-build': 'manual',
  'muse-code': 'manual',
  cursor: 'manual',
  perplexity: 'manual',
  chatgpt: 'manual',
  generic: 'manual',
};

describe('HARVEST_MAP drift vs capability.json wellKnown.adapters', () => {
  test('every wellKnown adapter id is in the map', () => {
    const missing = WELL_KNOWN_IDS.filter((id) => !(id in HARVEST_MAP));
    expect(missing).toEqual([]);
  });

  test('every map id is in wellKnown.adapters', () => {
    const known = new Set(WELL_KNOWN_IDS);
    const extra = MAP_IDS.filter((id) => !known.has(id));
    expect(extra).toEqual([]);
  });

  test('exactly the 13 adapters from the V10 table', () => {
    expect(MAP_IDS.sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(WELL_KNOWN_IDS.sort()).toEqual(Object.keys(EXPECTED).sort());
  });
});

describe('connectionClass', () => {
  test('matches the hardcoded V10 class table', () => {
    for (const [id, klass] of Object.entries(EXPECTED)) {
      expect(connectionClass(id)).toBe(klass);
    }
  });

  test('throws on an unknown adapter id', () => {
    expect(() => connectionClass('hermes')).toThrow(/unknown harness adapter/);
  });
});

describe('autoInstall', () => {
  test('is true for every non-manual class', () => {
    for (const [id, klass] of Object.entries(EXPECTED)) {
      if (klass === 'manual') continue;
      expect(autoInstall(id)).toBe(true);
    }
  });

  test('is false for every manual adapter — no auto-install promise', () => {
    for (const [id, klass] of Object.entries(EXPECTED)) {
      if (klass !== 'manual') continue;
      expect(autoInstall(id)).toBe(false);
    }
  });
});

describe('wiringSnippet', () => {
  const creds = { client_id: 'gbrain_cl_example', mcp_url: 'https://brain.example/mcp' };

  test('auto-install classes mention grant already wrote config and the class name', () => {
    for (const [id, klass] of Object.entries(EXPECTED)) {
      if (klass === 'manual') continue;
      const snip = wiringSnippet(id, creds);
      expect(snip).toContain('gbrain mcp grant already wrote this adapter\'s config');
      expect(snip).toContain(`(${klass})`);
      expect(snip).not.toContain('we have not runtime-tested this adapter');
    }
  });

  test('manual class is copy/paste with client_id + mcp_url and the untested note', () => {
    for (const [id, klass] of Object.entries(EXPECTED)) {
      if (klass !== 'manual') continue;
      const snip = wiringSnippet(id, creds);
      expect(snip).toContain(creds.client_id);
      expect(snip).toContain(creds.mcp_url);
      expect(snip.toLowerCase()).toContain('we have not runtime-tested this adapter');
      expect(snip).not.toContain('already wrote this adapter\'s config');
    }
  });
});

describe('annotateAdapters', () => {
  test('attaches connectionClass and autoInstall from the map', () => {
    const out = annotateAdapters([{ id: 'claude-code', label: 'Claude Code' }, { id: 'generic' }]);
    expect(out[0]).toEqual({
      id: 'claude-code',
      label: 'Claude Code',
      connectionClass: 'claude-json',
      autoInstall: true,
    });
    expect(out[1]).toEqual({
      id: 'generic',
      connectionClass: 'manual',
      autoInstall: false,
    });
  });
});
