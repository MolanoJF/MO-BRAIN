import type { DiffSummary, ReadSpaceMove, SpaceHeads } from '../agent/types.ts';

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
  delete: <T = unknown>(path: string): Promise<T> => request<T>(path, 'DELETE'),
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
  index: { sync: unknown; embed: unknown };
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
