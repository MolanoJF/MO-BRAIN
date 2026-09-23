// test/unit/capabilities.test.ts
import { test, expect } from 'bun:test';
import { capabilitiesFor, asBrainMode } from '../../src/control/capabilities.ts';

test('personal mode has no team capabilities', () => {
  expect(capabilitiesFor('personal')).toEqual({ invite: false, sharedSources: false, grants: false });
});

test('company mode has every team capability', () => {
  expect(capabilitiesFor('company')).toEqual({ invite: true, sharedSources: true, grants: true });
});

test('an unknown stored mode reads as personal — the smaller surface', () => {
  expect(asBrainMode('company')).toBe('company');
  expect(asBrainMode('personal')).toBe('personal');
  expect(asBrainMode('enterprise')).toBe('personal');
});
