import type { DiffSummary, ReadSpaceMove, SpaceHeads } from '../agent/types.ts';
import type { PackDraft, PackMutation } from '../control/schemaDraft.ts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * The parsed refusal body. A `slot_taken` carries `nextFree`, a
     * `sub_hourly_limit` carries `holder` — the console renders those as
     * choices, so a message-only error would lose the choice.
     */
    readonly body: Record<string, unknown> = {},
  ) { super(message); this.name = 'ApiError'; }
}

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      (payload as { error?: string }).error ?? `HTTP ${res.status}`,
      res.status,
      payload as Record<string, unknown>,
    );
  }
  return payload as T;
}

export const api = {
  get: <T = unknown>(path: string): Promise<T> => request<T>(path, 'GET'),
  post: <T = unknown>(path: string, body?: unknown): Promise<T> => request<T>(path, 'POST', body ?? {}),
  patch: <T = unknown>(path: string, body?: unknown): Promise<T> => request<T>(path, 'PATCH', body ?? {}),
  /**
   * A DELETE may carry a body: `DELETE /api/sources/:id` reads `{ mode, confirm }`
   * to tell archive from remove. Bodyless callers (`scheduleApi.remove`,
   * `Members.tsx`) are unchanged — `body` stays `undefined` and no body is sent.
   */
  delete: <T = unknown>(path: string, body?: unknown): Promise<T> => request<T>(path, 'DELETE', body),
  put: <T = unknown>(path: string, body?: unknown): Promise<T> => request<T>(path, 'PUT', body ?? {}),
};

/**
 * The signed-in identity, from Better Auth's own session endpoint.
 *
 * D7 needs it and cannot get it anywhere else: the revert is signed with the
 * acting admin's git identity (`actorIdentity(ctx.userId)` in
 * `src/control/routes/runs.ts`), and for a revert THIS page just performed, that
 * actor is by construction the session's own user — the one identity the console
 * reads from the server rather than inventing. A signed-out visitor gets `null`,
 * never a placeholder name.
 */
export type SessionUser = { email: string; name: string | null };

export const sessionApi = {
  me: async (): Promise<SessionUser | null> => {
    // Better Auth answers `{session, user}` or `null`; anything else (a 401 from
    // a deployment that mounts no session route) reads as "no identity known".
    const body = await api
      .get<{ user?: { email?: unknown; name?: unknown } } | null>('/auth/get-session')
      .catch(() => null);
    const user = body?.user;
    if (typeof user?.email !== 'string' || user.email === '') return null;
    return { email: user.email, name: typeof user.name === 'string' ? user.name : null };
  },
  /**
   * Better Auth's own sign-out route. The console has had no sign-out until
   * now — an account box that names the signed-in email with no way to
   * leave it is a conspicuous hole. Callers do a full page reload after
   * this resolves rather than unwinding React state: the session cookie is
   * gone, every cached page is stale, and a reload is the honest response.
   */
  signOut: async (): Promise<void> => {
    await api.post('/auth/sign-out', {});
  },
};

/**
 * The Files surface (`src/control/routes/files.ts`). Types mirror the routes'
 * projections exactly: the Space list carries each Connection's access so the
 * picker can say read-only vs can-edit without a second, admin-only call, and
 * the tree carries only the entries an operator may browse. The PUT below
 * (`filesApi.save`) is wired to that same route file, so this client can both
 * read and write.
 */

export type SpaceSummary = { id: string; sourceId: string; name: string; access: 'read' | 'write'; zone: 'personal' | 'company' };
export type FileEntry = { path: string; size: number; isMarkdown: boolean };
export type SpaceTree = { sourceId: string; root: string; entries: FileEntry[] };
export type FileContent = { content: string; sha: string; size: number };

/** Encode each path segment but keep `/` as the separator. */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * The put result. `committed: false, error: 'stale'` is a RESULT, not a
 * throw: another writer changed the file on disk, so the save wrote NOTHING and
 * the page renders the reload choice. `index` is the route's index-step
 * envelope and stays `unknown` here — the page shows the commit, not the steps.
 */
export type FileSaveResult =
  | { committed: true; sha: string; bypass: boolean; index: unknown }
  | { committed: false; error: 'stale'; sha: string | null; bypass: boolean };

export const filesApi = {
  list: () => api.get<{ spaces: SpaceSummary[] }>('/spaces'),
  tree: (sourceId: string) => api.get<SpaceTree>(`/spaces/${encodeURIComponent(sourceId)}/files`),
  file: (sourceId: string, path: string) =>
    api.get<FileContent>(`/spaces/${encodeURIComponent(sourceId)}/files/${encodePath(path)}`),
  save: (sourceId: string, path: string, body: { content: string; expectedSha: string; message?: string }) =>
    api.put<FileSaveResult>(`/spaces/${encodeURIComponent(sourceId)}/files/${encodePath(path)}`, body),
  /** The full-history `.bundle` download URL — a plain `<a href>`, not a
   *  `fetch()`: the browser streams the download and carries the session
   *  cookie itself, so this is a link the page renders, not a call it makes. */
  exportUrl: (sourceId: string) => `/api/spaces/${encodeURIComponent(sourceId)}/export`,
};

/**
 * The schema-pack surface (`src/control/routes/schema.ts`).
 *
 * Two honesty rules are encoded in these types, not in the pages:
 *   - a pack that failed to resolve carries `error` and EMPTY arrays — never a
 *     silent empty list that masquerades as "this pack brings nothing";
 *   - `pageTypes` / `linkVerbs` on a per-Space row are `number | null`, and NULL
 *     means the pack detail failed to resolve. Never render it as 0.
 *
 * `tier` on a per-Space row is `'per-source-db'` for an override; for an
 * inherited row it is the brain-wide tier (e.g. `'home-config'`). At
 * 0.50.5.0 gbrain offers no per-Space pack READBACK, so an override is the
 * STORED intent (`config get schema_pack.source.<id>`), not a resolved state —
 * see docs/schema-pack-findings.md S6 Gate 2.
 */
export type PackPageType = {
  name: string;
  primitive: string;
  pathPrefixes: string[];
  aliases: string[];
  extractable: boolean;
  expertRouting: boolean;
};

export type PackDetail = {
  name: string;
  version: string | null;
  description: string | null;
  extends: string | null;
  /** A bundled pack is read-only: gbrain refuses to mutate it (PACK_READONLY). */
  bundled: boolean;
  /** Shipped by Mobrain, seeded at ops boot, read-only to every API. */
  managed: boolean;
  pageTypes: PackPageType[];
  linkVerbs: string[];
  linkTypes: { name: string; inverse: string | null; pageType: string | null; targetType: string | null }[];
  filingRules: { kind: string; directory: string; description: string | null }[];
  takesKinds: string[];
  error: string | null;
};

/**
 * The authoring surface's response shapes, mirroring Task 5's routes exactly.
 * A pack's `own` declarations come from the UNRESOLVED manifest
 * (`schema.showRaw`), so the editor can tell "own" from "inherited"; it is
 * NULL when that read failed, and a caller must not treat that as "owns
 * nothing". `SchemaLint` is gbrain's own lint envelope.
 */
export type SchemaLintRule = { rule: string; message: string; hint?: string };
export type SchemaLint = { ok: boolean; errors: SchemaLintRule[]; warnings: SchemaLintRule[] };

export type PackOwnDeclarations = { pageTypes: string[]; linkVerbs: string[] };

export type PackDetailResponse = {
  effective: PackDetail;
  own: PackOwnDeclarations | null;
  editable: boolean;
  usedBy: { brain: boolean; sources: string[] };
};

export type PackCreateBody =
  | { mode: 'draft'; draft: PackDraft }
  | { mode: 'fork'; from: string; name: string };

export type PackCreateResult = {
  ok: boolean;
  name: string;
  /** gbrain's `validate` diagnosis; `errors` arrives only on a 400 refusal. */
  error: string | null;
  lint: SchemaLint | null;
};

export type ScaffoldResult = {
  sourceId: string;
  pack: string | null;
  created: string[];
  skipped: string[];
  error: string | null;
};

export type PackMutateResult = {
  ok: boolean;
  batchId: string;
  applied: number;
  error: string | null;
  lint: SchemaLint | null;
  scaffolded: ScaffoldResult[];
};

export type PackRemoveResult = { ok: boolean; removed: boolean };
export type ScaffoldResponse = { ok: boolean; results: ScaffoldResult[] };

export type SchemaSyncPerPrefix = {
  type: string;
  prefix: string;
  would_apply: number;
  applied: number;
  dead_prefix: boolean;
  sample_slugs: string[];
};

/** gbrain's own `schema sync --json` envelope; preview and apply share it. */
export type SchemaSync = {
  apply: boolean;
  pack_identity: string | null;
  per_prefix: SchemaSyncPerPrefix[];
  total_would_apply: number;
  total_applied: number;
};

export type SchemaSourcePack = {
  sourceId: string;
  name: string;
  kind: string;
  pack: string | null;
  tier: string | null;
  pageTypes: number | null;
  linkVerbs: number | null;
  inherited: boolean;
};

export type SetSourcePackResult = {
  ok: boolean;
  sourceId: string;
  pack: string;
  tier: string;
  inherited: boolean;
};

export const schemaPacksApi = {
  /** Every known pack's EFFECTIVE manifest, via gbrain's own resolver. */
  list: () => api.get<{ packs: PackDetail[] }>('/schema/packs'),
  /** Each Space's stored-intent pack (or the inherited brain-wide pack). */
  sources: () => api.get<{ sources: SchemaSourcePack[] }>('/schema/sources'),
  setSourcePack: (sourceId: string, pack: string) =>
    api.post<SetSourcePackResult>(`/schema/sources/${encodeURIComponent(sourceId)}`, { pack }),
  resetSourcePack: (sourceId: string) =>
    api.delete<{ ok: boolean; sourceId: string; pack: string | null; tier: string | null; inherited: true }>(
      `/schema/sources/${encodeURIComponent(sourceId)}`,
    ),
  /** `source` absent is the brain-wide run, unchanged. */
  previewSync: (source?: string) =>
    api.post<SchemaSync>('/schema/preview', source === undefined ? {} : { source }),
  runSync: (source?: string) =>
    api.post<SchemaSync>('/schema/sync', source === undefined ? {} : { source }),

  /** One pack's effective detail, plus its own declarations and its users. */
  get: (name: string) => api.get<PackDetailResponse>(`/schema/packs/${encodeURIComponent(name)}`),
  /** Create from a validated draft, or fork an existing pack. Not activation. */
  create: (body: PackCreateBody) => api.post<PackCreateResult>('/schema/packs', body),
  /** One atomic batch through gbrain's own mutator; a refusal is a 409. */
  mutate: (name: string, mutations: PackMutation[]) =>
    api.post<PackMutateResult>(`/schema/packs/${encodeURIComponent(name)}/mutations`, { mutations }),
  /** Refused with a 409 while the brain or a Space still resolves the pack. */
  remove: (name: string) => api.delete<PackRemoveResult>(`/schema/packs/${encodeURIComponent(name)}`),
  /** Create-only folder scaffolding, per Space. Never one green summary. */
  scaffold: (source?: string) =>
    api.post<ScaffoldResponse>('/schema/scaffold', source === undefined ? {} : { source }),
};

/**
 * The Sources admin surface (`src/control/routes/sources.ts`).
 *
 * `pageCount` / `lastSyncAt` / `federated` are live gbrain values and are
 * `null` when `sourcesListOk` is false; the page says so rather than showing 0.
 * `inGbrain` flags a `spaces` row gbrain does not list, and `unregistered` is
 * the other direction. `remove` is destructive: an unconfirmed remove answers
 * HTTP 409 `{ error: 'confirmation_required', preview }`, which arrives as an
 * `ApiError` whose body is the impact preview the operator must see first.
 */
export type SourceSummary = {
  sourceId: string;
  name: string;
  kind: string;
  pack: string | null;
  tier: string | null;
  pageTypes: number | null;
  linkVerbs: number | null;
  inherited: boolean;
  pageCount: number | null;
  lastSyncAt: string | null;
  federated: boolean | null;
  inGbrain: boolean;
};

export type RemoveSourceResult = {
  ok: true;
  mode: 'archive' | 'remove';
  sourceId: string;
  preview?: string;
};

export const sourcesApi = {
  list: () =>
    api.get<{ sources: SourceSummary[]; unregistered: string[]; sourcesListOk: boolean }>('/sources'),
  add: (body: { sourceId: string; name: string; description?: string }) =>
    api.post<{ ok: true; sourceId: string; isolationNotice: string }>('/sources', body),
  rename: (sourceId: string, name: string) =>
    api.patch<{ ok: true; sourceId: string; name: string }>(
      `/sources/${encodeURIComponent(sourceId)}`, { name },
    ),
  remove: (sourceId: string, body: { mode: 'archive' | 'remove'; confirm?: boolean }) =>
    api.delete<RemoveSourceResult>(`/sources/${encodeURIComponent(sourceId)}`, body),
};

/**
 * The schedules surface (`src/control/routes/schedules.ts`). Types mirror the
 * routes' projections: the schedule list carries its Connection denormalization
 * because `/api/connections` is admin-only, and run history carries `summary`
 * (counts/status) and never stdout or argv.
 */

export type ScheduleConnection = {
  id: string;
  clientName: string;
  state: string;
  memberRole: string | null;
  writeSpace: string | null;
};

export type ScheduleRow = {
  id: string;
  name: string;
  preset: string | null;
  /**
   * `schedules.operation` is nullable since Task 4: an `agent_prompt` schedule
   * runs a model, not a gbrain command, so it has no operation at all. The type
   * said `string` until Task 13 and that was a lie the page could have relied on
   * (`PresetRow.operation` already says `string | null` for the same reason).
   */
  operation: string | null;
  kind: string;
  connectionId: string | null;
  intervalSeconds: number | null;
  calendarHour: number | null;
  calendarMinute: number | null;
  calendarDaysOfWeek: number[] | null;
  slotMinute: number | null;
  gapPolicy: string;
  ambiguousPolicy: string;
  catchupPolicy: string;
  overlapPolicy: string;
  misfireGraceSeconds: number;
  reportPolicy: string;
  notifies: boolean;
  timeoutSeconds: number;
  enabled: boolean;
  disabledReason: string | null;
  lastMaterializedAt: string | null;
  createdAt: string;
  connection: ScheduleConnection | null;
};

export type RunRow = {
  id: string;
  slot: string;
  fireAt: string;
  state: string;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  classification: string | null;
  reportPath: string | null;
  summary: unknown;
  createdAt: string;
};

export type AlertRow = {
  id: string;
  scheduleId: string | null;
  runId: string | null;
  kind: string;
  detail: unknown;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  at: string;
};

export type PresetRow = {
  id: string;
  title: string;
  description: string;
  kind: string;
  operation: string | null;
  params: Record<string, unknown>;
  defaults: Record<string, unknown>;
  tunableInterval?: number[];
  requiresRole?: string;
  system?: true;
};

export type ScheduleSettings = {
  timezone: string;
  quietHoursStart: number;
  quietHoursEnd: number;
};

export type CreateScheduleBody = {
  name?: string;
  connectionId?: string;
  preset?: string;
  operation?: string;
  params?: Record<string, unknown>;
  kind?: string;
  intervalSeconds?: number;
  calendarHour?: number;
  calendarMinute?: number;
  calendarDaysOfWeek?: number[] | null;
  notifies?: boolean;
  catchupPolicy?: string;
  overlapPolicy?: string;
  reportPolicy?: string;
  /**
   * D3 — the agent payload, which `AGENT_CREATE_KEYS` in
   * `src/control/routes/schedules.ts` accepts and which nothing here declared
   * until an operator asked for it. The set is CLOSED on purpose: the route
   * refuses an unknown key rather than ignoring it, so a field this type does
   * not name is a field no schedule can carry (a tool allowlist, a shell
   * option). `agentBudgetUsd` stays text, like the column, so a cap never
   * round-trips through a float.
   */
  agentPrompt?: string;
  agentModel?: string;
  agentMaxTokens?: number;
  agentBudgetUsd?: string;
};

/** Only the columns an operator may change: a fenced param is never sent. */
export type SchedulePatch = {
  name?: string;
  enabled?: boolean;
  params?: Record<string, unknown>;
  intervalSeconds?: number;
  calendarHour?: number;
  calendarMinute?: number;
  calendarDaysOfWeek?: number[] | null;
  catchupPolicy?: string;
  overlapPolicy?: string;
  reportPolicy?: string;
};

export const scheduleApi = {
  list: () => api.get<{ schedules: ScheduleRow[] }>('/schedules'),
  presets: () => api.get<{ presets: PresetRow[]; system: string[] }>('/schedule-presets'),
  alerts: () => api.get<{ alerts: AlertRow[] }>('/schedule-alerts'),
  acknowledge: (id: string) => api.post<{ ok: boolean }>(`/schedule-alerts/${encodeURIComponent(id)}/ack`),
  runs: (id: string) => api.get<{ runs: RunRow[] }>(`/schedules/${encodeURIComponent(id)}/runs`),
  create: (body: CreateScheduleBody) => api.post<ScheduleRow>('/schedules', body),
  update: (id: string, patch: SchedulePatch) => api.patch<ScheduleRow>(`/schedules/${encodeURIComponent(id)}`, patch),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/schedules/${encodeURIComponent(id)}`),
  runNow: (id: string) => api.post<{ ok: boolean; run: { slot: string } }>(`/schedules/${encodeURIComponent(id)}/run-now`),
  settings: () => api.get<{ settings: ScheduleSettings }>('/org/schedule-settings'),
  saveSettings: (patch: Partial<ScheduleSettings>) =>
    api.patch<{ settings: ScheduleSettings }>('/org/schedule-settings', patch),
};

/**
 * The upgrades surface (`src/control/routes/upgrades.ts`, Task 13).
 *
 * The route returns the control DB's rows verbatim plus `detectUpdate`'s
 * classified envelope (`src/upgrade/detect.ts`). Those server shapes are the
 * source of truth; this client adapts them into the small view models the
 * page reads, in one place, so a column rename upstream surfaces here instead
 * of in every JSX branch. Two real mismatches the plan's samples did not know
 * about and that this adapter absorbs:
 *   - `upgrade_runs` names the closing column `endedAt`, not `finishedAt`;
 *   - `upgrade_events.step` holds the EVENT TYPE (`step_started`), while the
 *     step NAME it happened to lives in `data.step`.
 */
export type DetectResult = {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  changelog_diff: string;
  release_url: string;
  error?: 'network_error' | 'no_releases' | 'malformed_response';
};

export type UpgradeRunRow = {
  id: string;
  fromVersion: string;
  toVersion: string;
  state: string;
  startedAt: string;
  finishedAt: string | null;
  snapshotId: string | null;
  createdBy: string;
};

export type UpgradeEventRow = { id: string; runId: string; seq: number; at: string; type: string; data: unknown };

export type ChecklistItemRow = {
  id: string; runId: string; gbrainVersion: string; itemKey: string;
  prompt: string; why: string | null; state: string; decidedBy: string | null; decidedAt: string | null;
};

export type LedgerRow = { id: string; gbrainVersion: string; state: string; notes: string | null };

export type CapabilityDrift = {
  versionChanged: boolean; toolsAdded: string[]; toolsRemoved: string[];
  adaptersAdded: string[]; adaptersRemoved: string[]; profilesChanged: boolean;
};

export type DriftResult = {
  signal: 'drift' | 'no_drift' | 'single_snapshot';
  from: string; to: string;
  diff: CapabilityDrift | null;
};

export type UpgradeRunDetail = {
  run: UpgradeRunRow; events: UpgradeEventRow[]; checklist: ChecklistItemRow[]; ledger: LedgerRow[];
};

/** The route's own shapes, exactly as `src/control/routes/upgrades.ts` returns them. */
type ServerDetect = {
  status: 'up_to_date' | 'available' | 'unknown';
  error: 'network_error' | 'no_releases' | 'malformed_response' | null;
  currentVersion: string | null;
  candidateVersion: string | null;
  changelog: string | null;
  releaseUrl: string | null;
};

type ServerRun = {
  id: string; fromVersion: string; toVersion: string; state: string;
  startedAt: string; endedAt: string | null; snapshotId: string | null; createdBy: string | null;
};

type ServerEvent = {
  id: string; runId: string; seq: number; at: string;
  step: string; level: string; message: string; data: unknown;
};

type ServerDetail = {
  run: ServerRun; events: ServerEvent[]; checklist: ChecklistItemRow[]; ledger: LedgerRow[];
};

const toRunRow = (r: ServerRun): UpgradeRunRow => ({
  id: r.id, fromVersion: r.fromVersion, toVersion: r.toVersion, state: r.state,
  startedAt: r.startedAt, finishedAt: r.endedAt, snapshotId: r.snapshotId,
  createdBy: r.createdBy ?? '',
});

const toEventRow = (e: ServerEvent): UpgradeEventRow => ({
  id: e.id, runId: e.runId, seq: e.seq, at: e.at, type: e.step, data: e.data,
});

const countOf = (a: string[] | undefined): number => a?.length ?? 0;

export const upgradeApi = {
  available: async (): Promise<DetectResult> => {
    const r = await api.get<ServerDetect>('/upgrades/available');
    return {
      current_version: r.currentVersion ?? '',
      latest_version: r.candidateVersion ?? '',
      update_available: r.status === 'available',
      changelog_diff: r.changelog ?? '',
      release_url: r.releaseUrl ?? '',
      ...(r.error ? { error: r.error } : {}),
    };
  },
  list: async (): Promise<{ runs: UpgradeRunRow[] }> => {
    const r = await api.get<{ runs: ServerRun[] }>('/upgrades');
    return { runs: r.runs.map(toRunRow) };
  },
  detail: async (id: string): Promise<UpgradeRunDetail> => {
    const r = await api.get<ServerDetail>(`/upgrades/${encodeURIComponent(id)}`);
    return {
      run: toRunRow(r.run), events: r.events.map(toEventRow),
      checklist: r.checklist, ledger: r.ledger,
    };
  },
  drift: async (from: string, to: string): Promise<DriftResult> => {
    try {
      const diff = await api.get<CapabilityDrift>(
        `/upgrades/drift?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      const changed =
        diff.versionChanged === true ||
        countOf(diff.toolsAdded) > 0 || countOf(diff.toolsRemoved) > 0 ||
        countOf(diff.adaptersAdded) > 0 || countOf(diff.adaptersRemoved) > 0 ||
        diff.profilesChanged === true;
      return { signal: changed ? 'drift' : 'no_drift', from, to, diff };
    } catch (e) {
      // `driftBetween` THROWS `SingleSnapshotError` when only one version has a
      // snapshot; the route's guard turns that into a 400. That is "nothing to
      // compare", not "no drift" — never let the catch collapse it into the
      // clean-comparison sentence (the trap Task 8 exists to close).
      if (e instanceof ApiError && e.status === 400) {
        return { signal: 'single_snapshot', from, to, diff: null };
      }
      throw e;
    }
  },
  ack: (itemId: string) => api.post<{ item: ChecklistItemRow }>(`/upgrades/checklist/${encodeURIComponent(itemId)}/ack`),
  decline: (itemId: string) => api.post<{ item: ChecklistItemRow }>(`/upgrades/checklist/${encodeURIComponent(itemId)}/decline`),
};

/**
 * The runs surface (`src/control/routes/runs.ts`, Tasks 6 and 13).
 *
 * The route's projection IS the contract: prompt, events, usage, diff, cost and
 * attribution arrive in ONE response, and never the run token, the gateway token
 * or a raw model request body. What this adapter adds is only what the page
 * cannot honestly do for itself:
 *   - `agent_runs.diff_summary`, `heads_before` and `heads_after` are jsonb, so
 *     they leave the route as `unknown`. They are read into the agent lane's own
 *     types here (`src/agent/types.ts`, type-only import — nothing of the server
 *     reaches the bundle), once, instead of being re-cast in every JSX branch;
 *   - `costUsd` is `string | null` and NULL means **could not be priced**
 *     (honesty rule 3), so it is carried through as NULL and never coerced to 0;
 *   - `/health`'s `runner` block is read into a typed row whose `state` stays
 *     verbatim, including a value this build does not know — the page's label
 *     function, not the adapter, decides what is green.
 *
 * Money stays a string end to end, exactly as `agent_runs.budget_usd` and
 * `agent_run_usage.cost_usd` store it: a float round-trip is the one way a cap
 * can move.
 */

export type AgentRunRow = {
  runId: string;
  scheduleId: string;
  scheduleName: string | null;
  /** `schedule_runs.state` — the scheduler's vocabulary, not a second one. */
  state: string;
  attempt: number;
  slot: string;
  fireAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  model: string;
  harnessVersion: string;
  /** The cap this run was claimed under. A string, like every other amount here. */
  budgetUsd: string;
  /** NULL = could not be priced. Never render as $0.00 (honesty rule 3). */
  costUsd: string | null;
  /** D11's class, read from the row — never reconstructed from the transcript (L14). */
  failureClass: string | null;
  numTurns: number;
  revertedAt: string | null;
  revertCommit: string | null;
};

/** One `agent_run_events` row: the REDACTED harness frame, as structure. */
export type AgentRunEventRow = { seq: number; at: string; kind: string; data: unknown };

/** One `agent_run_usage` row: one metered model call through the gateway. */
export type AgentRunUsageRow = {
  seq: number;
  at: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: string | null;
  /** `max_tokens` is a truncation the harness caused; our own cap is `budget_exceeded`. */
  stopReason: string | null;
  httpStatus: number | null;
};

export type AgentRunDetail = AgentRunRow & {
  connectionId: string | null;
  clientName: string | null;
  /** `schedules.agent_prompt` — the exact words the harness was handed. */
  prompt: string | null;
  events: AgentRunEventRow[];
  usage: AgentRunUsageRow[];
  failureDetail: unknown;
  diff: DiffSummary | null;
  heads: { before: SpaceHeads; after: SpaceHeads };
  tokenRevokedAt: string | null;
};

/**
 * `/api/health`'s runner block, as D12 defines it: three states on the wire,
 * plus `unreported` for a control plane that answers nothing at all. Only
 * `connected` is ever green (honesty rule 8) and a state this build does not
 * know keeps its own name rather than being mapped onto a friendlier one.
 */
export type RunnerStatusRow = { state: string; lastSeenAt: string | null; version: string | null };

/** `revertRun`'s success, from `src/agent/revert.ts`. Refusals arrive as 409s. */
export type RevertSuccess = {
  reverted: true;
  runId: string;
  sourceId: string;
  revertCommit: string;
  revertedAt: string;
  files: Array<{ status: string; path: string }>;
  /**
   * F16: `purge` is the remove-by-name step (`PagePurge` in
   * `src/agent/revert.ts`) — the one a re-sync cannot stand in for, because the
   * page an agent run writes is created brain-first — and it records a SKIP as
   * loudly as a removal. The console renders both, so a git-only revert cannot
   * be mistaken for one that moved the index.
   */
  index: {
    purge: Array<{ slug: string; outcome: string; detail: string }>;
    sync: unknown;
    embed: unknown;
  };
};

/** The route's own shapes, so the jsonb columns can be narrowed exactly once. */
type ServerRunEvent = { seq: number; at: string; kind: string; data: unknown };
type ServerRunUsage = AgentRunUsageRow;
type ServerRunDetail = AgentRunRow & {
  connectionId: string | null;
  clientName: string | null;
  prompt: string | null;
  events: ServerRunEvent[];
  usage: ServerRunUsage[];
  failureDetail: unknown;
  diff: unknown;
  heads: { before: unknown; after: unknown };
  tokenRevokedAt: string | null;
};

/**
 * `diff_summary` read defensively. A run that never finished has none; a summary
 * written by an older build may be missing a field. The console's attribution
 * hedge reads `foreignCommitCount` against `commits.length`, and `undefined`
 * there would render as "NaN of NaN commits" — an absence the page must be able
 * to name, so a malformed summary reads as NO summary rather than a partial one.
 */
export function toDiffSummary(raw: unknown): DiffSummary | null {
  if (raw === null || typeof raw !== 'object') return null;
  const outer = raw as { write?: unknown; readSpaceMoves?: unknown; concurrentWriters?: unknown };
  if (outer.write === null || typeof outer.write !== 'object') return null;
  const write = outer.write as Record<string, unknown>;
  if (typeof write.sourceId !== 'string' || !Array.isArray(write.commits)) return null;
  const moves = Array.isArray(outer.readSpaceMoves) ? outer.readSpaceMoves : [];
  return {
    write: {
      sourceId: write.sourceId,
      before: typeof write.before === 'string' ? write.before : '',
      after: typeof write.after === 'string' ? write.after : '',
      commits: write.commits as DiffSummary['write']['commits'],
      files: Array.isArray(write.files) ? (write.files as DiffSummary['write']['files']) : [],
      concurrentWriters: write.concurrentWriters === true,
      foreignCommitCount: typeof write.foreignCommitCount === 'number' ? write.foreignCommitCount : 0,
      foreignAuthors: Array.isArray(write.foreignAuthors)
        ? write.foreignAuthors.filter((a): a is string => typeof a === 'string')
        : [],
    },
    readSpaceMoves: moves.filter(
      (m): m is ReadSpaceMove => typeof (m as ReadSpaceMove | null)?.sourceId === 'string',
    ),
    concurrentWriters: outer.concurrentWriters === true,
  };
}

/** `heads_before` / `heads_after`: a Space id -> the commit HEAD pointed at. */
export function toSpaceHeads(raw: unknown): SpaceHeads {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
}

/** `unreported` is the console's word for a control plane that says nothing —
 *  never `disabled` (which claims the lane is off) and never green. */
export function toRunnerStatus(raw: unknown): RunnerStatusRow {
  if (raw === null || typeof raw !== 'object') return { state: 'unreported', lastSeenAt: null, version: null };
  const r = raw as { state?: unknown; lastSeenAt?: unknown; version?: unknown };
  return {
    state: typeof r.state === 'string' && r.state !== '' ? r.state : 'unreported',
    lastSeenAt: typeof r.lastSeenAt === 'string' ? r.lastSeenAt : null,
    version: typeof r.version === 'string' ? r.version : null,
  };
}

export const runApi = {
  list: (limit?: number) =>
    api.get<{ runs: AgentRunRow[] }>(`/runs${limit === undefined ? '' : `?limit=${limit}`}`),
  detail: async (runId: string): Promise<AgentRunDetail> => {
    const r = await api.get<ServerRunDetail>(`/runs/${encodeURIComponent(runId)}`);
    return {
      ...r,
      diff: toDiffSummary(r.diff),
      heads: { before: toSpaceHeads(r.heads?.before), after: toSpaceHeads(r.heads?.after) },
    };
  },
  /** D10: nothing auto-reverts. `confirm` is the second explicit confirmation a
   *  range containing another writer's commits requires, and it is a query param
   *  on the route rather than a body — there is no body. */
  revert: (runId: string, confirm?: 'concurrent') =>
    api.post<RevertSuccess>(
      `/runs/${encodeURIComponent(runId)}/revert${confirm === 'concurrent' ? '?confirm=concurrent' : ''}`,
    ),
  /** The runner's three states. `/api/health` is unauthenticated, so this asks it
   *  for nothing else — kinds and counts are the whole vocabulary. */
  runner: async (): Promise<RunnerStatusRow> => {
    const r = await api.get<{ runner?: unknown }>('/health');
    return toRunnerStatus(r.runner);
  },
};

/**
 * The spend surface (`src/control/routes/spend.ts`, Tasks 11 and 12).
 *
 * One payload carries BOTH meters and both coverages. Three honesty rules are
 * encoded in these types, not in the page:
 *   - `ours.totalUsd` is `number | null`: NULL means runs existed but none could
 *     be priced, and it must be rendered as words, never `$0.00` (honesty rule
 *     3, `Runs.tsx:159-161`);
 *   - `brain` is `BrainUsage | null`, and `coverage.brainReachable` says whether
 *     the ledger was read at all — an unread ledger is UNKNOWN, never zero, and
 *     the two totals are never added together;
 *   - `brain.coverage.notCovered` is upstream's own list of what its ledger
 *     misses and is carried VERBATIM, character for character (D8).
 */
export type SpendRow = { key: string; label: string; runs: number; costUsd: number | null; unpricedRuns: number };

/** gbrain's own ledger, as `src/ops/usage.ts` maps `get_usage`'s receipt. */
export type BrainUsage = {
  windowDays: number;
  totals: { calls: number; inputTokens: number; outputTokens: number;
            cacheReadTokens: number; cacheWriteTokens: number; costUsd: number };
  byModel: { model: string; calls: number; costUsd: number | null; unpricedCalls: number }[];
  byPhase: { phase: string; calls: number; costUsd: number }[];
  coverage: { source: string; loggedSince: string | null; tablePresent: boolean;
              pricedCalls: number; unpricedCalls: number; notCovered: string[] };
};

export type SpendReport = {
  windowDays: number;
  ours: { totalUsd: number | null; unpricedRuns: number;
          byMember: SpendRow[]; bySchedule: SpendRow[]; byModel: SpendRow[] };
  brain: BrainUsage | null;
  coverage: { ours: string[]; brainReachable: boolean };
};

/**
 * The route clamps `days` 1–365 and defaults to 30; the page asks for one
 * window and reads back `windowDays` from the payload rather than assuming it.
 */
export const spendApi = {
  get: (days = 30) => api.get<SpendReport>(`/spend?days=${encodeURIComponent(String(days))}`),
};

/** Zones D7 — admin-issued access to COMPANY Spaces. */
export type GrantRow = { membershipId: string; spaceId: string; access: 'read' | 'write' };

export const grantsApi = {
  list: () => api.get<{ grants: GrantRow[] }>('/grants'),
  put: (row: GrantRow) => api.put<{ ok: true }>('/grants', row),
  remove: (membershipId: string, spaceId: string) =>
    api.delete<{ removed: boolean; revoked: string[]; rescoped: string[] }>('/grants', { membershipId, spaceId }),
};

export type OrgInfo = {
  id: string; name: string; brainMode: 'personal' | 'company';
  capabilities: { invite: boolean; sharedSources: boolean; grants: boolean };
  memberCount: number; role: string;
};

export const orgApi = {
  get: () => api.get<OrgInfo>('/org'),
  rename: (name: string) => api.patch<{ ok: true; name: string }>('/org', { name }),
  setMode: (mode: 'personal' | 'company', name?: string) =>
    api.patch<{ ok: true; brainMode: string }>('/org/mode', name ? { mode, name } : { mode }),
};

export type MyConnection = {
  space: { id: string; sourceId: string; name: string };
  connection: { id: string; state: string; readSpaceIds: string[] } | null;
  readable: Array<{ id: string; sourceId: string; name: string }>;
};

export const myConnectionApi = {
  get: () => api.get<MyConnection>('/my/connection'),
  setReads: (readSpaceIds: string[]) => api.put<{ ok: true; readSpaceIds: string[] }>('/my/connection', { readSpaceIds }),
};

/**
 * The caller's private MCP handoff (`GET /api/my/mcp`). `credentials` is the
 * stored object, not a string. `snippet` is already built for that harness.
 */
export type MyMcpConfig = {
  mcp_url: string;
  harness: string;
  credentials: unknown;
  snippet: string;
  agentInstructions: string | null;
  verify: { status: string | null; message: string | null } | null;
};

export const myMcpApi = {
  get: () => api.get<MyMcpConfig>('/my/mcp'),
  reissue: () => api.post<MyMcpConfig>('/my/mcp/reissue'),
};
