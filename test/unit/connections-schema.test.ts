import { test, expect } from 'bun:test';
import { schema } from '../../src/control/db/client.ts';

test('connections table has verify-status columns', () => {
  const cols = Object.keys(schema.connections);
  expect(cols).toContain('verifyStatus');
  expect(cols).toContain('verifiedAt');
  expect(cols).toContain('verifyMessage');
});
