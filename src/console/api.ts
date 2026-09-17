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
  operation: string;
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
