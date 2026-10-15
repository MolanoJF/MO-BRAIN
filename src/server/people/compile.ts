import type { ClientPurpose, ClientSpec, Grant, Source, User } from '../types.ts';

// gbrain grant profiles (confirmed by probe P2; see the probes file).
export const PROFILE_READER = 'memory-reader';
export const PROFILE_WRITER = 'memory-writer';
export const PROFILE_INSTANCE = 'coding-agent';
/** Owner and admin agents. Probe P2: no profile is read,write,admin. `operator` wrote unfenced (`notes/probe-admin-op`, slug unchanged). P3 passed: do not fall back to memory-writer. */
export const ADMIN_AGENT_PROFILE = 'operator';

const RANK: Record<string, number> = { [PROFILE_READER]: 0, [PROFILE_WRITER]: 1, [ADMIN_AGENT_PROFILE]: 2, [PROFILE_INSTANCE]: 3 };

export type AccessState = { sources: Source[]; grants: Grant[] };

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);
export const clientName = {
  agent: (userId: string) => `mb-agent-${short(userId)}`,
  ui: (userId: string) => `mb-ui-${short(userId)}`,
  companyWriter: (userId: string, sourceId: string) => `mb-cw-${short(userId)}-${sourceId}`,
  instance: () => 'mb-instance',
};

const uniqSorted = (xs: string[]) => [...new Set(xs)].sort();

function make(purpose: ClientPurpose, userId: string | null, name: string, profile: string, write: string, reads: string[]): ClientSpec {
  return { purpose, userId, name, profile, writeSource: write, readSources: uniqSorted(reads.filter((r) => r !== write)) };
}

function activeCompany(state: AccessState): string[] {
  return state.sources.filter((s) => s.status === 'active' && s.kind === 'company').map((s) => s.id).sort();
}

function privateOf(userId: string, state: AccessState): Source | undefined {
  return state.sources.find((s) => s.status === 'active' && s.kind === 'private' && s.ownerUserId === userId);
}

/** The agent and ui clients a person should hold right now (spec §5.2). */
export function compileUserClients(user: User, state: AccessState): ClientSpec[] {
  if (user.status !== 'active') return [];
  const company = activeCompany(state);
  const mine = state.grants.filter((g) => g.userId === user.id && company.includes(g.sourceId));
  const granted = uniqSorted(mine.map((g) => g.sourceId));
  const agentGranted = uniqSorted(mine.filter((g) => g.agentReads).map((g) => g.sourceId));
  const agent = (profile: string, write: string, reads: string[]) => make('agent', user.id, clientName.agent(user.id), profile, write, reads);
  const ui = (write: string, reads: string[]) => make('ui', user.id, clientName.ui(user.id), PROFILE_READER, write, reads);

  if (user.role === 'owner' || user.role === 'admin') {
    const p = privateOf(user.id, state);
    return p ? [agent(ADMIN_AGENT_PROFILE, p.id, company), ui(p.id, company)] : [];
  }
  if (user.role === 'member') {
    const p = privateOf(user.id, state);
    return p ? [agent(PROFILE_WRITER, p.id, agentGranted), ui(p.id, granted)] : [];
  }
  const out: ClientSpec[] = [];
  if (agentGranted.length) out.push(agent(PROFILE_READER, agentGranted[0]!, agentGranted));
  if (granted.length) out.push(ui(granted[0]!, granted));
  return out;
}

export function instanceSpec(owner: User, state: AccessState): ClientSpec {
  const p = privateOf(owner.id, state);
  if (!p) throw new Error('owner has no private source');
  return make('instance', null, clientName.instance(), PROFILE_INSTANCE, p.id, activeCompany(state));
}

export function companyWriterSpec(user: User, sourceId: string): ClientSpec {
  return make('company_writer', user.id, clientName.companyWriter(user.id, sourceId), PROFILE_WRITER, sourceId, []);
}

/** The least access that both specs allow, or null when the client must be revoked. */
export function narrowest(before: ClientSpec | undefined, after: ClientSpec | undefined): ClientSpec | null {
  if (!before || !after || before.writeSource !== after.writeSource) return null;
  const keep = new Set(after.readSources);
  const profile = (RANK[before.profile] ?? 9) <= (RANK[after.profile] ?? 9) ? before.profile : after.profile;
  return { ...after, profile, readSources: before.readSources.filter((r) => keep.has(r)) };
}

export function sameSpec(a: ClientSpec, b: ClientSpec): boolean {
  return a.profile === b.profile && a.writeSource === b.writeSource && a.readSources.join(',') === b.readSources.join(',');
}
