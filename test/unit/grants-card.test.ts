// test/unit/grants-card.test.ts
import { test, expect } from 'bun:test';
import { nextAccess } from '../../src/console/pages/GrantsCard.tsx';

test('a grant cell cycles none → read → write → none', () => {
  expect(nextAccess('none')).toBe('read');
  expect(nextAccess('read')).toBe('write');
  expect(nextAccess('write')).toBe('none');
});
