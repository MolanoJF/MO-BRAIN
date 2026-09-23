import { test, expect } from 'bun:test';
import { switchCopy } from '../../src/console/pages/General.tsx';

test('the switch offers the other mode', () => {
  expect(switchCopy('personal').action).toBe('Turn into a company brain');
  expect(switchCopy('company').action).toBe('Switch back to a personal brain');
});
