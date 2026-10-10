import { test, expect } from 'bun:test';
import { switchCopy } from '../../src/console/pages/Admin.tsx';
import { showsSpend } from '../../src/console/pages/General.tsx';

test('the switch offers the other mode', () => {
  expect(switchCopy('personal').action).toBe('Turn into a company brain');
  expect(switchCopy('company').action).toBe('Switch back to a personal brain');
});

test('spend on General is an admin section, never a member\'s', () => {
  expect(showsSpend('owner')).toBe(true);
  expect(showsSpend('admin')).toBe(true);
  expect(showsSpend('member')).toBe(false);
  expect(showsSpend('viewer')).toBe(false);
  expect(showsSpend(undefined)).toBe(false);
  expect(showsSpend(null)).toBe(false);
});
