// test/unit/rules.test.ts
import { describe, expect, test } from 'bun:test';
import {
  assertCanInvite, assertCanOffboard, assertCanSetRole, assertCanSwitchMode, assertCompanyMode, slugFor,
} from '../../src/server/people/rules.ts';
import type { User } from '../../src/server/types.ts';

const u = (id: string, role: User['role']): User => ({ id, email: `${id}@x.io`, name: null, role, status: 'active', createdAt: new Date() });
const code = (f: () => void) => { try { f(); return 'ok'; } catch (e) { return (e as { code: string }).code; } };

describe('rules', () => {
  test('company-only operations refuse in personal mode (rule 4)', () => {
    expect(code(() => assertCompanyMode('personal'))).toBe('company_mode_required');
    expect(code(() => assertCompanyMode('company'))).toBe('ok');
  });

  test('only the owner switches mode; back to personal only as the sole active user (rules 2, 3)', () => {
    expect(code(() => assertCanSwitchMode(u('a', 'admin'), 'company', 1))).toBe('forbidden');
    expect(code(() => assertCanSwitchMode(u('o', 'owner'), 'company', 3))).toBe('ok');
    expect(code(() => assertCanSwitchMode(u('o', 'owner'), 'personal', 2))).toBe('not_sole_member');
    expect(code(() => assertCanSwitchMode(u('o', 'owner'), 'personal', 1))).toBe('ok');
  });

  test('invites: owner any non-owner role, admin only member or viewer, nobody invites an owner', () => {
    expect(code(() => assertCanInvite(u('o', 'owner'), 'admin'))).toBe('ok');
    expect(code(() => assertCanInvite(u('a', 'admin'), 'admin'))).toBe('forbidden');
    expect(code(() => assertCanInvite(u('a', 'admin'), 'member'))).toBe('ok');
    expect(code(() => assertCanInvite(u('o', 'owner'), 'owner'))).toBe('invalid_role');
    expect(code(() => assertCanInvite(u('m', 'member'), 'viewer'))).toBe('forbidden');
  });

  test('roles: the owner is untouchable, only the owner moves admins, nobody changes their own role (rule 10)', () => {
    expect(code(() => assertCanSetRole(u('o', 'owner'), u('o2', 'owner'), 'member'))).toBe('owner_is_fixed');
    expect(code(() => assertCanSetRole(u('a', 'admin'), u('m', 'member'), 'admin'))).toBe('forbidden');
    expect(code(() => assertCanSetRole(u('a', 'admin'), u('b', 'admin'), 'member'))).toBe('forbidden');
    expect(code(() => assertCanSetRole(u('o', 'owner'), u('b', 'admin'), 'member'))).toBe('ok');
    expect(code(() => assertCanSetRole(u('a', 'admin'), u('a', 'admin'), 'member'))).toBe('cannot_change_self');
    expect(code(() => assertCanSetRole(u('o', 'owner'), u('m', 'member'), 'owner'))).toBe('invalid_role');
  });

  test('offboarding: never the owner; admins only offboard members and viewers', () => {
    expect(code(() => assertCanOffboard(u('a', 'admin'), u('o', 'owner')))).toBe('owner_is_fixed');
    expect(code(() => assertCanOffboard(u('a', 'admin'), u('b', 'admin')))).toBe('forbidden');
    expect(code(() => assertCanOffboard(u('o', 'owner'), u('b', 'admin')))).toBe('ok');
    expect(code(() => assertCanOffboard(u('m', 'member'), u('v', 'viewer')))).toBe('forbidden');
  });

  test('slugFor makes a gbrain-safe id stem', () => {
    expect(slugFor('Ada.Lovelace+work@X.io')).toBe('ada-lovelace-work');
    expect(slugFor('Engineering & Ops')).toBe('engineering-ops');
    expect(slugFor('***')).toBe('x');
  });
});
