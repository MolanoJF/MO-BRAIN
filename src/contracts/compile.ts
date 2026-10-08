import type { Role } from '../control/rbac.ts';

/** The 6 ids in contracts/v0.50.0.0/capability.json wellKnown.profiles. */
export const GRANT_PROFILES = [
  'memory-reader',
  'memory-writer',
  'coding-agent',
  'operator',
  'delegating-agent',
  'full',
] as const;
export type GrantProfileId = typeof GRANT_PROFILES[number];

export type Warning = {
  id: 'read-isolation-per-space' | 'write-fence-disables-extraction'
    | 'additions-need-new-token' | 'rotation-is-not-revocation' | 'verify-partial-is-not-green';
  severity: 'info' | 'warn' | 'blocking';
  affects: string[];
};

export type CompiledConnection = {
  profile: GrantProfileId;
  sourceId: string;
  federatedRead: string[];
  boundSlugPrefixes: string[] | null;
  surface: string;
  tokenTtl: number;
  budgetUsdPerDay: number | null;
  boundMaxConcurrent: number | null;
  warnings: Warning[];
};

const TOKEN_TTL_MIN = 60;
const TOKEN_TTL_MAX = 90 * 24 * 60 * 60; // 7_776_000 = 90d in seconds
const TOKEN_TTL_DEFAULT = 3600;

const ROLE_TO_PROFILE = {
  viewer: 'memory-reader',
  member: 'memory-writer',
  admin: 'coding-agent',
  owner: 'coding-agent',
} as const satisfies Record<Role, GrantProfileId>;

/** Tools a write fence removes, plus the put_page auto-extract skip. */
const WRITE_FENCE_AFFECTS: string[] = [
  'extract_entities',
  'extract_facts',
  'forget_fact',
  'ontology_propose',
  'sources_add',
  'sources_remove',
  'POST /ingest',
  "put_page automatic fact extraction skipped",
];

export function compileConnection(
  member: { role: Role },
  writeSpace: { sourceId: string; slug: string },
  readSpaces: { sourceId: string }[],
  opts?: {
    boundSlugPrefixes?: string[];
    tokenTtl?: number;
    budgetUsdPerDay?: number;
    privateSpace?: boolean;
  },
): CompiledConnection {
  const base = ROLE_TO_PROFILE[member.role];
  if (!base) throw new Error(`unknown role ${String(member.role)}`);
  const profile: GrantProfileId = opts?.privateSpace === true && base === 'memory-reader'
    ? 'memory-writer'
    : base;

  const boundSlugPrefixes = opts?.boundSlugPrefixes !== undefined
    ? [...opts.boundSlugPrefixes]
    : null;

  return {
    profile,
    sourceId: writeSpace.sourceId,
    federatedRead: uniqueSorted(
      readSpaces.map((s) => s.sourceId).filter((id) => id !== writeSpace.sourceId),
    ),
    boundSlugPrefixes,
    // Member skills: `full`, not the profile's `starter` default —
    // list_skills/get_skill are outside STARTER_OPS. Scopes still come from
    // the profile (docs/archive/member-skills-findings.md). Applied by
    // auth.rescopeClient, since mcp grant takes no --surface.
    surface: 'full',
    tokenTtl: clampTokenTtl(opts?.tokenTtl),
    budgetUsdPerDay: opts?.budgetUsdPerDay ?? null,
    boundMaxConcurrent: null,
    warnings: honestyWarnings(boundSlugPrefixes),
  };
}

/** A4. Deterministic, collision-free, traceable in `auth clients` and in audit. */
export function clientName(membershipId: string, spaceSlug: string): string {
  return `bs-${membershipId.slice(0, 8)}-${spaceSlug}`;
}

/** Honesty rule 3: removals apply to the live token, additions do not. */
export function diffCompiled(before: CompiledConnection | null, after: CompiledConnection): {
  removals: string[]; additions: string[]; requiresNewToken: boolean;
} {
  const additions: string[] = [];
  const removals: string[] = [];

  const beforeReads = new Set(before?.federatedRead ?? []);
  const afterReads = new Set(after.federatedRead);
  for (const id of afterReads) if (!beforeReads.has(id)) additions.push(id);
  for (const id of beforeReads) if (!afterReads.has(id)) removals.push(id);

  if (before === null) {
    additions.push(after.sourceId);
  } else if (before.sourceId !== after.sourceId) {
    removals.push(before.sourceId);
    additions.push(after.sourceId);
  }

  const beforeCaps = profileCaps(before?.profile ?? null);
  const afterCaps = profileCaps(after.profile);
  for (const cap of afterCaps) if (!beforeCaps.has(cap)) additions.push(cap);
  for (const cap of beforeCaps) if (!afterCaps.has(cap)) removals.push(cap);

  diffFences(before, after, additions, removals);

  additions.sort();
  removals.sort();
  return { removals, additions, requiresNewToken: additions.length > 0 };
}

function uniqueSorted(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

function clampTokenTtl(n: number | undefined): number {
  const v = n === undefined || !Number.isFinite(n) ? TOKEN_TTL_DEFAULT : n;
  if (v < TOKEN_TTL_MIN) return TOKEN_TTL_MIN;
  if (v > TOKEN_TTL_MAX) return TOKEN_TTL_MAX;
  return v;
}

function honestyWarnings(boundSlugPrefixes: string[] | null): Warning[] {
  const warnings: Warning[] = [
    { id: 'read-isolation-per-space', severity: 'info', affects: [] },
  ];
  if (boundSlugPrefixes !== null) {
    warnings.push({
      id: 'write-fence-disables-extraction',
      severity: 'warn',
      affects: [...WRITE_FENCE_AFFECTS],
    });
  }
  warnings.push(
    { id: 'additions-need-new-token', severity: 'warn', affects: [] },
    { id: 'rotation-is-not-revocation', severity: 'warn', affects: [] },
    { id: 'verify-partial-is-not-green', severity: 'warn', affects: [] },
  );
  return warnings;
}

function profileCaps(profile: GrantProfileId | null): Set<string> {
  const caps = new Set<string>();
  if (!profile) return caps;
  caps.add('cap:read');
  if (profile !== 'memory-reader') caps.add('cap:write');
  if (profile === 'coding-agent' || profile === 'operator' || profile === 'delegating-agent' || profile === 'full') {
    caps.add('cap:coding');
  }
  if (profile === 'operator' || profile === 'full') caps.add('cap:admin');
  if (profile === 'delegating-agent' || profile === 'full') caps.add('cap:agent');
  return caps;
}

function diffFences(
  before: CompiledConnection | null,
  after: CompiledConnection,
  additions: string[],
  removals: string[],
): void {
  // A new connection already requires a token via sourceId; fence shape is not
  // an access-addition on first compile.
  if (before === null) return;
  const prev = before.boundSlugPrefixes;
  const next = after.boundSlugPrefixes;
  if (prev === null && next === null) return;
  if (prev === null && next !== null) {
    removals.push('fence:none');
    return;
  }
  if (prev !== null && next === null) {
    additions.push('fence:none');
    return;
  }
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  for (const p of nextSet) if (!prevSet.has(p)) additions.push(`prefix:${p}`);
  for (const p of prevSet) if (!nextSet.has(p)) removals.push(`prefix:${p}`);
}
