import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { orgApi, type OrgInfo } from './api.ts';

type OrgState = { org: OrgInfo | null; reload: () => Promise<void> };

const OrgContext = createContext<OrgState>({ org: null, reload: async () => {} });

/**
 * The org's mode, read once per shell and re-read after a switch. `null` while
 * loading or on failure; consumers treat `null` as company mode, which only
 * ever shows MORE — the API still refuses what the mode does not allow.
 */
export function OrgProvider({ children }: { children: ReactNode }) {
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const reload = async () => {
    try { setOrg(await orgApi.get()); } catch { setOrg(null); }
  };
  useEffect(() => { void reload(); }, []);
  return <OrgContext.Provider value={{ org, reload }}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgState {
  return useContext(OrgContext);
}
