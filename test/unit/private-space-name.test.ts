import { test, expect, describe } from 'bun:test';
import { gbrainSourceName } from '../../src/control/privateSpaces.ts';

/**
 * A private Space's gbrain source name must be unique per membership (gbrain's
 * `sources.name` is UNIQUE); its `sourceId` is already unique. The console
 * label is the control-DB `spaces.name`, which stays 'My Space'.
 */
describe('gbrainSourceName', () => {
  test('a private space uses its sourceId when ownerMembershipId is set', () => {
    expect(gbrainSourceName({
      sourceId: 'my-space-abcd1234', ownerMembershipId: 'membership-1', name: 'My Space',
    })).toBe('my-space-abcd1234');
  });

  test('a shared space keeps its human-readable name', () => {
    expect(gbrainSourceName({
      sourceId: 'customers', ownerMembershipId: null, name: 'Customers',
    })).toBe('Customers');
  });

  test('a shared space with no name falls back to its sourceId', () => {
    expect(gbrainSourceName({ sourceId: 'customers' })).toBe('customers');
  });
});
