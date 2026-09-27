import { test, expect } from 'bun:test';
import type { ClaimResult } from '../../src/control/claim.ts';

test('ClaimResult connections carry a verify field', () => {
  const sample: ClaimResult['connections'][number] = {
    connectionId: 'c1', credentials: {}, harness: 'generic', mcp_url: 'https://x',
    verify: { status: 'ok', message: null },
  };
  expect(sample.verify?.status).toBe('ok');
});
