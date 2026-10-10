import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, '../../src/console/pages/Access.tsx'), 'utf8');

test('Access shows and toggles control-server access per Connection', () => {
  expect(SRC).toContain('controlEnabled: boolean;');
  expect(SRC).toContain('api.post(`/connections/${id}/control`, { enabled })');
  expect(SRC).toContain("'Make data-only'");
  expect(SRC).toContain("'Allow control'");
});
