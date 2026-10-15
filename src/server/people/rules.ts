import { HttpError } from '../http.ts';
import type { Mode, Role, User } from '../types.ts';

const fail = (status: number, code: string): never => { throw new HttpError(status, code); };
const isAdminish = (r: Role) => r === 'owner' || r === 'admin';

export function assertCompanyMode(mode: Mode): void {
  if (mode !== 'company') fail(403, 'company_mode_required');
}

export function assertCanSwitchMode(actor: User, to: Mode, nonDisabledUsers: number): void {
  if (actor.role !== 'owner') fail(403, 'forbidden');
  if (to === 'personal' && nonDisabledUsers > 1) fail(409, 'not_sole_member');
}

export function assertCanInvite(actor: User, role: Role): void {
  if (role === 'owner') fail(400, 'invalid_role');
  if (!isAdminish(actor.role)) fail(403, 'forbidden');
  if (role === 'admin' && actor.role !== 'owner') fail(403, 'forbidden');
}

export function assertCanSetRole(actor: User, target: User, role: Role): void {
  if (target.role === 'owner') fail(409, 'owner_is_fixed');
  if (role === 'owner') fail(400, 'invalid_role');
  if (actor.id === target.id) fail(409, 'cannot_change_self');
  if (!isAdminish(actor.role)) fail(403, 'forbidden');
  if ((role === 'admin' || target.role === 'admin') && actor.role !== 'owner') fail(403, 'forbidden');
}

export function assertCanOffboard(actor: User, target: User): void {
  if (target.role === 'owner') fail(409, 'owner_is_fixed');
  if (!isAdminish(actor.role)) fail(403, 'forbidden');
  if (target.role === 'admin' && actor.role !== 'owner') fail(403, 'forbidden');
}

export function slugFor(text: string): string {
  const local = text.includes('@') ? text.split('@')[0]! : text;
  const s = local.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'x';
}
