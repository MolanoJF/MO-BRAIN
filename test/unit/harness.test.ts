import { test, expect } from 'bun:test';
import { wiringSnippet, AGENT_INSTRUCTIONS, connectionClass } from '../../src/control/harness.ts';

test('manual-class snippet is a valid http-transport MCP config with a bearer header', () => {
  const { snippet } = wiringSnippet('generic', {
    client_id: 'cid', mcp_url: 'https://example.test/mcp', access_token: 'tok',
  });
  const parsed = JSON.parse(snippet.split('\n').slice(1, -1).join('\n')) as {
    mcpServers: { gbrain: { type: string; url: string; headers: { Authorization: string } } };
  };
  expect(parsed.mcpServers.gbrain.type).toBe('http');
  expect(parsed.mcpServers.gbrain.url).toBe('https://example.test/mcp');
  expect(parsed.mcpServers.gbrain.headers.Authorization).toBe('Bearer tok');
});

test('manual-class snippet no longer contains a permanent untested disclaimer', () => {
  const { snippet } = wiringSnippet('generic', { mcp_url: 'https://x', access_token: 't' });
  expect(snippet).not.toContain('We have not runtime-tested this adapter');
});

test('agentInstructions is present only when opts.skills is true', () => {
  const withSkills = wiringSnippet('generic', { mcp_url: 'https://x', access_token: 't' }, { skills: true });
  const withoutSkills = wiringSnippet('generic', { mcp_url: 'https://x', access_token: 't' }, { skills: false });
  expect(withSkills.agentInstructions).toBe(AGENT_INSTRUCTIONS);
  expect(withoutSkills.agentInstructions).toBeNull();
});

test('auto-install classes are unaffected and stay a plain string message', () => {
  const { snippet } = wiringSnippet('claude-code', {});
  expect(snippet).toBe("gbrain mcp grant already wrote this adapter's config (claude-json).");
});
