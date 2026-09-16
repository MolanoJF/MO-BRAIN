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
