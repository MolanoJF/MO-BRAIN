import { test, expect } from 'bun:test';
import { claimFormError } from '../../src/console/pages/Claim.tsx';

test('the password must be 12+ characters and confirmed', () => {
  expect(claimFormError('', '')).toBe('Use at least 12 characters.');
  expect(claimFormError('short', 'short')).toBe('Use at least 12 characters.');
  expect(claimFormError('long-enough-pass', 'long-enough-pasS')).toBe('Passwords do not match.');
  expect(claimFormError('long-enough-pass', 'long-enough-pass')).toBeNull();
});
