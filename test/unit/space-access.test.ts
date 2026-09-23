// test/unit/space-access.test.ts
import { test, expect, describe } from 'bun:test';
import { accessFromGrants } from '../../src/control/spaceAccess.ts';

const me = 'm-me';
const other = 'm-other';
const company = 's-company';
const mine = 's-mine';

describe('accessFromGrants', () => {
  test('a personal Space is write for its owner, for every role', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(accessFromGrants(role, [], mine, me, me)).toBe('write');
    }
  });

  test("someone else's personal Space is null for every role — grants cannot pierce it", () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(accessFromGrants(role, [{ spaceId: mine, access: 'write' }], mine, other, me)).toBeNull();
    }
  });

  test('admin and owner reach every company Space without a grant', () => {
    expect(accessFromGrants('owner', [], company, null, me)).toBe('write');
    expect(accessFromGrants('admin', [], company, null, me)).toBe('write');
  });

  test('member and viewer reach a company Space only through a grant', () => {
    expect(accessFromGrants('member', [], company, null, me)).toBeNull();
    expect(accessFromGrants('member', [{ spaceId: company, access: 'read' }], company, null, me)).toBe('read');
    expect(accessFromGrants('viewer', [{ spaceId: company, access: 'write' }], company, null, me)).toBe('write');
  });

  test('an unknown access value is no access, never a guess', () => {
    expect(accessFromGrants('member', [{ spaceId: company, access: 'admin' }], company, null, me)).toBeNull();
  });
});
