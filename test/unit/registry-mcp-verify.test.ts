import { test, expect } from 'bun:test';
import { OPERATIONS } from '../../src/contracts/registry.ts';

test('mcp.verify accepts url, credentialsFile, and delegate', () => {
  const names = OPERATIONS['mcp.verify']!.params.map((p) => p.name);
  expect(names).toContain('url');
  expect(names).toContain('credentialsFile');
  expect(names).toContain('delegate');
});
