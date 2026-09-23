import { test, expect } from 'bun:test';
import { claimFormError, normalizeClaimEmail } from '../../src/console/pages/Claim.tsx';

test('the password must be 12+ characters and confirmed', () => {
  expect(claimFormError('', '')).toBe('Use at least 12 characters.');
  expect(claimFormError('short', 'short')).toBe('Use at least 12 characters.');
  expect(claimFormError('long-enough-pass', 'long-enough-pasS')).toBe('Passwords do not match.');
  expect(claimFormError('long-enough-pass', 'long-enough-pass')).toBeNull();
  expect(claimFormError('x'.repeat(128), 'x'.repeat(128))).toBeNull();
  expect(claimFormError('x'.repeat(129), 'x'.repeat(129))).toBe('Use at most 128 characters.');
});

test('claim and sign-in share a trimmed, lowercased address', () => {
  expect(normalizeClaimEmail('  Person@Example.Test  ')).toBe('person@example.test');
  expect(normalizeClaimEmail('person@example.test')).toBe('person@example.test');
});
