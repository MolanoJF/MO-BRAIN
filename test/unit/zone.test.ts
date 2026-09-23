import { test, expect, describe } from 'bun:test';
import { zoneOf, canSeeZone, isAdminRole } from '../../src/control/zone.ts';

const me = 'm-me';
const other = 'm-other';

describe('zoneOf', () => {
  test('null owner is company, a set owner is personal', () => {
    expect(zoneOf(null)).toEqual({ kind: 'company' });
    expect(zoneOf(me)).toEqual({ kind: 'personal', ownerMembershipId: me });
  });
});

describe('canSeeZone — the privacy table', () => {
  const roles = ['owner', 'admin', 'member', 'viewer'] as const;

  for (const role of roles) {
    test(`${role}: own personal zone is visible`, () => {
      expect(canSeeZone({ role, membershipId: me }, { ownerMembershipId: me })).toBe(true);
    });
    test(`${role}: someone else's personal zone is NOT visible`, () => {
      expect(canSeeZone({ role, membershipId: me }, { ownerMembershipId: other })).toBe(false);
    });
    test(`${role}: company zone is visible`, () => {
      expect(canSeeZone({ role, membershipId: me }, { ownerMembershipId: null })).toBe(true);
    });
  }

  test('an unresolved write Space is admin-only', () => {
    expect(canSeeZone({ role: 'owner', membershipId: me }, null)).toBe(true);
    expect(canSeeZone({ role: 'admin', membershipId: me }, null)).toBe(true);
    expect(canSeeZone({ role: 'member', membershipId: me }, null)).toBe(false);
    expect(canSeeZone({ role: 'viewer', membershipId: me }, null)).toBe(false);
  });

  test('isAdminRole', () => {
    expect(isAdminRole('owner')).toBe(true);
    expect(isAdminRole('admin')).toBe(true);
    expect(isAdminRole('member')).toBe(false);
    expect(isAdminRole('viewer')).toBe(false);
  });
});
