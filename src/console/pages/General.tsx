import { useOrg } from '../OrgContext.tsx';
import { Appearance } from './Appearance.tsx';
import { Health } from './Health.tsx';
import { Spend } from './Spend.tsx';
import { Upgrades } from './Upgrades.tsx';

/**
 * Spend is a section of General, not a tab, and General is open to every role.
 * Mounting the section is what a member must not see: the page fetches the
 * ledger on mount, so a hidden-but-mounted Spend would still ask for it.
 * Unknown role fails closed — a missing org is not an admin.
 */
export function showsSpend(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function General() {
  const { org } = useOrg();
  return (
    <div className="space-y-10">
      <Health />
      {showsSpend(org?.role) && <Spend />}
      <Upgrades />
      <Appearance />
    </div>
  );
}
