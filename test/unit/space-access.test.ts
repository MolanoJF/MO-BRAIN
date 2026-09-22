import { test, expect, describe } from 'bun:test';
import { accessFromConnections, type ConnRow } from '../../src/control/spaceAccess.ts';
import type { Role } from '../../src/control/rbac.ts';

const SPACE = 'space-1';
const ROLES: Role[] = ['viewer', 'member', 'admin', 'owner'];

const WRITE_CONN: ConnRow = { writeSpaceId: SPACE, readSpaceIds: [] };
const READ_CONN: ConnRow = { writeSpaceId: 'other', readSpaceIds: [SPACE] };

describe('accessFromConnections private spaces', () => {
  test('a non-owner gets null for every role, admin/owner included', () => {
    for (const role of ROLES) {
      expect(accessFromConnections(role, [WRITE_CONN], SPACE, 'owner-m', 'other-m')).toBeNull();
      expect(accessFromConnections(role, [], SPACE, 'owner-m', 'other-m')).toBeNull();
    }
  });

  test('the owner resolves through their own write connection', () => {
    expect(accessFromConnections('viewer', [WRITE_CONN], SPACE, 'owner-m', 'owner-m')).toBe('write');
    expect(accessFromConnections('member', [WRITE_CONN], SPACE, 'owner-m', 'owner-m')).toBe('write');
  });

  test('the owner resolves through their own read listing', () => {
    expect(accessFromConnections('viewer', [READ_CONN], SPACE, 'owner-m', 'owner-m')).toBe('read');
    expect(accessFromConnections('member', [READ_CONN], SPACE, 'owner-m', 'owner-m')).toBe('read');
  });

  test('the owner with no connection gets null (the admin/owner override still applies)', () => {
    expect(accessFromConnections('viewer', [], SPACE, 'owner-m', 'owner-m')).toBeNull();
    expect(accessFromConnections('member', [], SPACE, 'owner-m', 'owner-m')).toBeNull();
    expect(accessFromConnections('admin', [], SPACE, 'owner-m', 'owner-m')).toBe('write');
    expect(accessFromConnections('owner', [], SPACE, 'owner-m', 'owner-m')).toBe('write');
  });
});

describe('accessFromConnections shared spaces', () => {
  test('admin/owner reach a shared space with no connections', () => {
    expect(accessFromConnections('admin', [], SPACE, null, 'any-m')).toBe('write');
    expect(accessFromConnections('owner', [], SPACE, null, 'any-m')).toBe('write');
  });

  test('member with a write conn gets write, with a read list gets read', () => {
    expect(accessFromConnections('member', [WRITE_CONN], SPACE, null, 'm')).toBe('write');
    expect(accessFromConnections('member', [READ_CONN], SPACE, null, 'm')).toBe('read');
  });

  test('member with no connections gets null', () => {
    expect(accessFromConnections('member', [], SPACE, null, 'm')).toBeNull();
  });

  test('viewer never writes from a read list', () => {
    expect(accessFromConnections('viewer', [READ_CONN], SPACE, null, 'm')).toBe('read');
    expect(accessFromConnections('viewer', [WRITE_CONN], SPACE, null, 'm')).toBe('write');
  });
});

describe('accessFromConnections readSpaceIds non-string skip', () => {
  test('a non-string entry never grants read', () => {
    const conn = { writeSpaceId: 'other', readSpaceIds: [42, null, { id: SPACE }, SPACE] } as unknown as ConnRow;
    expect(accessFromConnections('member', [conn], SPACE, null, 'm')).toBe('read');
    const junk = { writeSpaceId: 'other', readSpaceIds: [42, null, { id: SPACE }] } as unknown as ConnRow;
    expect(accessFromConnections('member', [junk], SPACE, null, 'm')).toBeNull();
  });
});
