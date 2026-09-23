/**
 * Zones spec D5 — `organizations.brain_mode` is the ONE flag, and this module is
 * the one place it becomes behaviour. Routes ask for a named capability, never
 * for the mode, so a future capability (say, SSO) is one line here.
 */
import { eq } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';

export type BrainMode = 'personal' | 'company';
export type Capability = 'invite' | 'sharedSources' | 'grants';

export function capabilitiesFor(mode: BrainMode): Record<Capability, boolean> {
  const company = mode === 'company';
  return { invite: company, sharedSources: company, grants: company };
}

export function asBrainMode(value: string): BrainMode {
  return value === 'company' ? 'company' : 'personal';
}

export async function orgMode(orgId: string): Promise<BrainMode> {
  const [org] = await getDb().select({ brainMode: schema.organizations.brainMode })
    .from(schema.organizations).where(eq(schema.organizations.id, orgId));
  return asBrainMode(org?.brainMode ?? 'personal');
}

export async function requireCapability(orgId: string, cap: Capability): Promise<void> {
  if (!capabilitiesFor(await orgMode(orgId))[cap]) {
    throw Object.assign(new Error('company_mode_required'), { status: 403 });
  }
}
