import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HARVEST_MAP,
  SKILLS_NOTE,
  agentInstructions,
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
  const creds = {
    client_id: 'gbrain_cl_example',
    mcp_url: 'https://brain.example/mcp',
    access_token: 'gbrain_at_example',
  };

  test('auto-install classes mention grant already wrote config and the class name', () => {
    for (const [id, klass] of Object.entries(EXPECTED)) {
      if (klass === 'manual') continue;
      const { snippet } = wiringSnippet(id, creds);
      expect(snippet).toContain('gbrain mcp grant already wrote this adapter\'s config');
      expect(snippet).toContain(`(${klass})`);
    }
  });

  test('manual class is a valid http-transport MCP config with a bearer header', () => {
    for (const [id, klass] of Object.entries(EXPECTED)) {
      if (klass !== 'manual') continue;
      const { snippet } = wiringSnippet(id, creds);
      const start = snippet.indexOf('{');
      const parsed = JSON.parse(snippet.slice(start, snippet.indexOf('\n}', start) + 2)) as {
        mcpServers: { gbrain: { type: string; url: string; headers: { Authorization: string } } };
      };
      expect(parsed.mcpServers.gbrain.type).toBe('http');
      expect(parsed.mcpServers.gbrain.url).toBe(creds.mcp_url);
      expect(parsed.mcpServers.gbrain.headers.Authorization).toBe(`Bearer ${creds.access_token}`);
      expect(snippet).not.toContain('already wrote this adapter\'s config');
    }
  });

  test('manual-class snippet no longer contains a permanent untested disclaimer', () => {
    const { snippet } = wiringSnippet('generic', { mcp_url: 'https://x', access_token: 't' });
    expect(snippet).not.toContain('We have not runtime-tested this adapter');
  });

  test('every harness snippet ends with the skills note, and agentInstructions is non-empty', () => {
    for (const id of Object.keys(HARVEST_MAP)) {
      const out = wiringSnippet(id, creds);
      expect(out.snippet.endsWith(SKILLS_NOTE)).toBe(true);
      expect(typeof out.agentInstructions).toBe('string');
      expect(out.agentInstructions.length).toBeGreaterThan(0);
    }
  });

  test('the skills note says this Connection serves no skills and names no skill tools', () => {
    expect(SKILLS_NOTE).toContain('this Connection does not serve skills');
    expect(SKILLS_NOTE).not.toContain('list_skills');
    expect(SKILLS_NOTE).not.toContain('get_skill');
    expect(SKILLS_NOTE).not.toContain('unavailable_tools');
    expect(SKILLS_NOTE).not.toMatch(/skillpack scaffold|--stub/);
  });

  test('agentInstructions points at the health URL, pin, gbrain repo and skill-autobench, and names no skill tools', () => {
    const text = agentInstructions('https://brain.example.com/mcp');
    expect(text).toContain('https://brain.example.com/api/health');
    expect(text).toContain('pin.observed');
    expect(text).toContain('https://github.com/garrytan/gbrain.git');
    expect(text).toContain('skill-autobench');
    expect(text).not.toContain('list_skills');
    expect(text).not.toContain('get_skill');
  });

  test('agentInstructions without an MCP URL falls back to the <this brain> placeholder', () => {
    expect(agentInstructions()).toContain('<this brain>/api/health');
  });

  test('auto-install classes are unaffected apart from the skills note', () => {
    const { snippet } = wiringSnippet('claude-code', {});
    expect(snippet).toBe(`gbrain mcp grant already wrote this adapter's config (claude-json).\n${SKILLS_NOTE}`);
  });

  test('control omitted is byte-identical to today\'s snippet', () => {
    for (const id of Object.keys(HARVEST_MAP)) {
      expect(wiringSnippet(id, creds).snippet)
        .toBe(wiringSnippet(id, creds, { control: undefined }).snippet);
    }
  });

  test('control adds a mobrain-control server with the same bearer, for every class', () => {
    for (const id of Object.keys(HARVEST_MAP)) {
      const { snippet } = wiringSnippet(id, { ...creds, access_token: 'tok-123' }, { control: { url: 'https://brain.example/api/control-mcp' } });
      const start = snippet.indexOf('{', snippet.indexOf('Mo-brain control server'));
      const fragment = JSON.parse(snippet.slice(start, snippet.indexOf('\n}', start) + 2));
      expect(fragment).toEqual({ mcpServers: { 'mobrain-control': {
        type: 'http', url: 'https://brain.example/api/control-mcp', headers: { Authorization: 'Bearer tok-123' },
      } } });
    }
  });

  test('the data server key stays gbrain', () => {
    const { snippet } = wiringSnippet('generic', { mcp_url: 'https://x/mcp', access_token: 't' }, { control: { url: 'https://x/api/control-mcp' } });
    expect(snippet).toContain('"gbrain"');
    expect(snippet).not.toContain('mobrain-data');
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
