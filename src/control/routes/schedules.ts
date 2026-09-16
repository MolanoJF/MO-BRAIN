/**
 * The schedule surface: CRUD, the preset catalogue, alerts, and the org's
 * schedule settings.
 *
 * Two honesty rules are enforced here, in code, not in a comment:
 *
 *   1. A FENCED param is refused, never merged. `--source` is derived by the
 *      scheduler from the Connection's write Space; a caller who could pass it
 *      could sync a Space they were never granted. `validateParams` throws on
 *      one, and the route turns that into a 400 — the value never reaches a row.
 *   2. A brain-wide command (`doctor`) is not fenceable to a Space at all, so
 *      it needs an admin-or-better Connection. The refusal carries
 *      `scope: 'brain-wide'` so the console renders its banner, not a generic
 *      error.
 *
 * A schedule's name becomes the `reports/<job-name>/` directory, so it is
 * validated against the slug shape and REFUSED, never sanitized.
 */
import { Hono, type Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, lt, ne } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, ROLE_RANK, type Role } from '../rbac.ts';
import { PRESETS, systemPresetsFor } from '../../scheduler/presets.ts';
import { SCHEDULER_COMMANDS, validateParams } from '../../scheduler/commands.ts';
import {
  assignSlot, isSubHourly, SUB_HOURLY_SECONDS, type CalendarFootprint,
} from '../../scheduler/stagger.ts';
import { isValidTimeZone } from '../../scheduler/time.ts';

export const scheduleRoutes = new Hono();

/** The name becomes `reports/<job-name>/`, so it must be slug-shaped. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The 409 detail for the one-sub-hourly-lane rule. Upstream's own guidance
 * (docs/guides/cron-schedule.md) is "don't over-cron": a sub-hourly job fires on
 * every 5-minute stagger slot, so the grid has nothing to stagger it against.
 */
export const ONE_LANE_EXPLANATION =
  'A sub-hourly schedule occupies every 5-minute stagger slot, so it cannot be '
  + 'staggered against another one. Disable the schedule holding the lane, or '
  + 'give this one an interval of an hour or more.';

/** Honesty rule 2's scope marker, in the refusal body the console reads. */
const BRAIN_WIDE_ERROR = 'brain-wide command requires an admin Connection';

const POLICY_VALUES = {
  gapPolicy: ['shift', 'skip'],
  ambiguousPolicy: ['first', 'second', 'both'],
  catchupPolicy: ['skip', 'run_latest', 'run_all'],
  overlapPolicy: ['skip', 'queue', 'kill_previous'],
  reportPolicy: ['always', 'on_change_or_failure', 'never'],
} as const;

type PolicyKey = keyof typeof POLICY_VALUES;
type PolicyFallbacks = Record<PolicyKey, string | undefined>;

type TunablePatch = {
  gapPolicy?: string;
  ambiguousPolicy?: string;
  catchupPolicy?: string;
  overlapPolicy?: string;
  reportPolicy?: string;
  timeoutSeconds?: number;
  misfireGraceSeconds?: number;
  notifies?: boolean;
};

type Ctx = { userId: string; orgId: string; role: Role };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'schedules_error';
}

function errorStatus(e: unknown): number {
  if (e && typeof e === 'object' && 'status' in e && typeof e.status === 'number') return e.status;
  return 400;
}

/**
 * `requireRole` signals 401/403 by throwing a Response; everything else thrown
 * inside a handler is a refusal with a message (400 unless it carries a status).
 */
const guard = (min: Role, handler: (c: Context, ctx: Ctx) => Promise<Response>) =>
  async (c: Context) => {
    let ctx: Ctx;
    try {
      ctx = await requireRole(c, min);
    } catch (r) {
      if (r instanceof Response) return r;
      throw r;
    }
    try {
      return await handler(c, ctx);
    } catch (e) {
      // c.json accepts Hono's StatusCode union, not a bare number; a thrown
      // refusal carries a plain status, defaulting to 400.
      const status = errorStatus(e) as 400 | 401 | 403 | 404 | 409 | 500;
      return c.json({ error: errorMessage(e) }, status);
    }
  };

/** Hono types a path param as `string | undefined`; an empty id is a 404. */
function paramOf(c: Context, name: string): string {
  return c.req.param(name) ?? '';
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function intOf(...candidates: unknown[]): number | null {
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isInteger(Number(v))) return Number(v);
  }
  return null;
}

/** 0=Sunday..6=Saturday, org-local. A non-array (or `null`) means every day. */
function asDays(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6);
}

function isDayList(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    && new Set(value).size === value.length;
}

/** Postgres unique violation (23505), read through drizzle's error wrapper. */
function isUniqueViolation(e: unknown): boolean {
  const cause = e && typeof e === 'object' && 'cause' in e ? e.cause : e;
  return !!cause && typeof cause === 'object' && 'code' in cause && cause.code === '23505';
}

async function audit(orgId: string, actor: string, action: string, target: string, after: unknown) {
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target, before: null, after: after as object });
}

function asRole(value: string): Role {
  if (value === 'owner' || value === 'admin' || value === 'member' || value === 'viewer') return value;
  throw Object.assign(new Error(`invalid membership role ${value}`), { status: 400 });
}

/** Admin-or-better acts org-wide; a member only ever on their own Connection. */
function ownsConnection(role: Role, userId: string, memberUserId: string | null): boolean {
  if (ROLE_RANK[role] >= ROLE_RANK.admin) return true;
  return memberUserId !== null && memberUserId === userId;
}

/**
 * The Connection a schedule will run as. The Connection — never the caller —
 * decides the `--source` fence, the report's write Space and the commit's
 * identity, so a foreign Connection is a 403, not a silently-accepted id.
 */
async function loadOwnConnection(
  orgId: string, connectionId: unknown, userId: string, role: Role,
): Promise<{ id: string; memberRole: Role } | null> {
  if (typeof connectionId !== 'string' || !connectionId) return null;
  const [row] = await getDb().select({
    id: schema.connections.id,
    organizationId: schema.connections.organizationId,
    memberUserId: schema.memberships.userId,
    memberRole: schema.memberships.role,
  })
    .from(schema.connections)
    .innerJoin(schema.memberships, eq(schema.connections.membershipId, schema.memberships.id))
    .where(eq(schema.connections.id, connectionId));

  if (!row || row.organizationId !== orgId) return null;
  if (!ownsConnection(role, userId, row.memberUserId)) return null;
  return { id: row.id, memberRole: asRole(row.memberRole) };
}

/**
 * A schedule plus the Connection denormalization the console needs to render
 * "runs as <clientName> · writes to <Space>". `/api/connections` is admin-only,
 * so a viewer's schedule list has to carry this itself.
 */
type ScheduleView = typeof schema.schedules.$inferSelect & {
  connection: {
    id: string;
    clientName: string;
    state: string;
    memberRole: string | null;
    writeSpace: string | null;
  } | null;
};

function toView(row: {
  schedules: typeof schema.schedules.$inferSelect;
  connections: typeof schema.connections.$inferSelect | null;
  memberships: typeof schema.memberships.$inferSelect | null;
  spaces: typeof schema.spaces.$inferSelect | null;
}): ScheduleView {
  const { schedules: s, connections: c, memberships: m, spaces: w } = row;
  return {
    ...s,
    connection: c
      ? {
        id: c.id,
        clientName: c.clientName,
        state: c.state,
        memberRole: m?.role ?? null,
        writeSpace: w?.sourceId ?? null,
      }
      : null,
  };
}

function scheduleQuery() {
  return getDb().select()
    .from(schema.schedules)
    .leftJoin(schema.connections, eq(schema.schedules.connectionId, schema.connections.id))
    .leftJoin(schema.memberships, eq(schema.connections.membershipId, schema.memberships.id))
    .leftJoin(schema.spaces, eq(schema.connections.writeSpaceId, schema.spaces.id));
}

/** One schedule in this org, or null when it is not ours to see. */
async function loadScheduleRow(orgId: string, id: string): Promise<ScheduleView | null> {
  const [row] = await scheduleQuery().where(eq(schema.schedules.id, id));
  if (!row || row.schedules.organizationId !== orgId) return null;
  return toView(row);
}

/** The member a Connection belongs to, for the schedule-ownership rule. */
async function memberUserIdOf(connectionId: string | null): Promise<string | null> {
  if (!connectionId) return null;
  const [row] = await getDb().select({ userId: schema.memberships.userId })
    .from(schema.connections)
    .innerJoin(schema.memberships, eq(schema.connections.membershipId, schema.memberships.id))
    .where(eq(schema.connections.id, connectionId));
  return row?.userId ?? null;
}

/**
 * The enabled calendar schedules of this org, as the stagger grid sees them.
 * A disabled schedule occupies nothing: that is what `enabled = false` means.
 */
async function calendarFootprints(orgId: string, exceptId?: string): Promise<CalendarFootprint[]> {
  const rows = await getDb().select({
    id: schema.schedules.id,
    slotMinute: schema.schedules.slotMinute,
    hour: schema.schedules.calendarHour,
    days: schema.schedules.calendarDaysOfWeek,
  })
    .from(schema.schedules)
    .where(and(
      eq(schema.schedules.organizationId, orgId),
      eq(schema.schedules.kind, 'calendar'),
      eq(schema.schedules.enabled, true),
    ));

  return rows
    .filter((r) => r.id !== exceptId && r.slotMinute != null && r.hour != null)
    .map((r) => ({ slotMinute: r.slotMinute!, hour: r.hour!, daysOfWeek: asDays(r.days) }));
}

/**
 * The one enabled sub-hourly schedule of this org, if any. At most one: a
 * sub-hourly interval occupies every slot on the grid, so a second one cannot
 * be staggered against the first. Returns the row so the 409 names the holder.
 */
async function subHourlyLane(orgId: string, exceptId?: string) {
  const [row] = await getDb().select({ id: schema.schedules.id, name: schema.schedules.name })
    .from(schema.schedules)
    .where(and(
      eq(schema.schedules.organizationId, orgId),
      eq(schema.schedules.kind, 'interval'),
      eq(schema.schedules.enabled, true),
      lt(schema.schedules.intervalSeconds, SUB_HOURLY_SECONDS),
      exceptId ? ne(schema.schedules.id, exceptId) : undefined,
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Validate the columns that carry DB CHECK constraints, so a bad value is a
 * named 400 rather than a raw Postgres message. Preset defaults fill the gap.
 */
function applyTunables(
  body: Record<string, unknown>, fallbacks: PolicyFallbacks,
): { ok: true; values: TunablePatch } | { ok: false; error: string } {
  const values: TunablePatch = {};

  for (const key of Object.keys(POLICY_VALUES) as PolicyKey[]) {
    const raw = body[key] ?? fallbacks[key];
    if (raw === undefined || raw === null) continue;
    const allowed: readonly string[] = POLICY_VALUES[key];
    if (typeof raw !== 'string' || !allowed.includes(raw)) {
      return { ok: false, error: `invalid_${key}` };
    }
    values[key] = raw;
  }

  if (body.timeoutSeconds !== undefined) {
    const timeout = intOf(body.timeoutSeconds);
    if (timeout === null || timeout < 30 || timeout > 21600) {
      return { ok: false, error: 'invalid_timeoutSeconds' };
    }
    values.timeoutSeconds = timeout;
  }

  if (body.misfireGraceSeconds !== undefined) {
    const grace = intOf(body.misfireGraceSeconds);
    if (grace === null || grace < 0) return { ok: false, error: 'invalid_misfireGraceSeconds' };
    values.misfireGraceSeconds = grace;
  }

  if (body.notifies !== undefined) {
    if (typeof body.notifies !== 'boolean') return { ok: false, error: 'invalid_notifies' };
    values.notifies = body.notifies;
  }

  return { ok: true, values };
}

const NO_PRESET_DEFAULTS: PolicyFallbacks = {
  gapPolicy: undefined,
  ambiguousPolicy: undefined,
  catchupPolicy: undefined,
  overlapPolicy: undefined,
  reportPolicy: undefined,
};

scheduleRoutes.get('/schedules', guard('viewer', async (c, { orgId }) => {
  const rows = await scheduleQuery()
    .where(eq(schema.schedules.organizationId, orgId))
    .orderBy(schema.schedules.name);
  return c.json({ schedules: rows.map(toView) });
}));

/** The schedule itself, unwrapped — the console and the exit gate read it flat. */
scheduleRoutes.get('/schedules/:id', guard('viewer', async (c, { orgId }) => {
  const schedule = await loadScheduleRow(orgId, paramOf(c, 'id'));
  if (!schedule) return c.json({ error: 'not_found' }, 404);
  return c.json(schedule);
}));

scheduleRoutes.get('/schedule-presets', guard('viewer', async (c, { orgId }) => {
  return c.json({ presets: Object.values(PRESETS), system: await systemPresetsFor(orgId) });
}));

scheduleRoutes.get('/schedule-alerts', guard('viewer', async (c, { orgId }) => {
  const alerts = await getDb().select().from(schema.scheduleAlerts)
    .where(eq(schema.scheduleAlerts.organizationId, orgId))
    .orderBy(desc(schema.scheduleAlerts.at))
    .limit(100);
  return c.json({ alerts });
}));

scheduleRoutes.post('/schedule-alerts/:id/ack', guard('member', async (c, { userId, orgId }) => {
  const id = paramOf(c, 'id');
  const [row] = await getDb().select({
    id: schema.scheduleAlerts.id,
    organizationId: schema.scheduleAlerts.organizationId,
    kind: schema.scheduleAlerts.kind,
    acknowledgedAt: schema.scheduleAlerts.acknowledgedAt,
  }).from(schema.scheduleAlerts).where(eq(schema.scheduleAlerts.id, id));
  if (!row || row.organizationId !== orgId) return c.json({ error: 'alert not found' }, 404);

  // Acknowledging twice keeps the FIRST acknowledgement: the column answers
  // "who saw this, and when", not "who clicked last".
  if (!row.acknowledgedAt) {
    await getDb().update(schema.scheduleAlerts)
      .set({ acknowledgedAt: new Date(), acknowledgedBy: userId })
      .where(eq(schema.scheduleAlerts.id, id));
  }
  await audit(orgId, userId, 'schedule.alert_ack', id, { kind: row.kind });
  return c.json({ ok: true });
}));

const orgScheduleSettings = {
  timezone: schema.organizations.timezone,
  quietHoursStart: schema.organizations.quietHoursStart,
  quietHoursEnd: schema.organizations.quietHoursEnd,
};

/**
 * The org's scheduling window, readable by anyone who can read a schedule: the
 * console renders quiet hours in org-local time with the IANA zone named, and a
 * viewer who cannot read them cannot explain why a job's output was held.
 */
scheduleRoutes.get('/org/schedule-settings', guard('viewer', async (c, { orgId }) => {
  const [row] = await getDb().select(orgScheduleSettings)
    .from(schema.organizations).where(eq(schema.organizations.id, orgId));
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ settings: row });
}));

scheduleRoutes.patch('/org/schedule-settings', guard('admin', async (c, { userId, orgId }) => {
  const body = asObject(await c.req.json());
  const patch: Record<string, unknown> = {};

  if (body.timezone !== undefined) {
    // A per-org IANA zone, not a fixed-offset alias: every wall-clock decision
    // the scheduler makes (quiet hours, DST, slot labels) assumes real DST.
    if (typeof body.timezone !== 'string' || !isValidTimeZone(body.timezone)) {
      return c.json({
        error: 'invalid_timezone',
        detail: 'expected an IANA zone (UTC or Region/City) — a fixed-offset alias like EST is refused',
      }, 400);
    }
    patch.timezone = body.timezone;
  }

  for (const key of ['quietHoursStart', 'quietHoursEnd'] as const) {
    if (body[key] === undefined) continue;
    const hour = intOf(body[key]);
    if (hour === null || hour < 0 || hour > 23) {
      return c.json({ error: 'invalid_quiet_hours', detail: 'a whole hour in [0, 23]' }, 400);
    }
    patch[key] = hour;
  }

  if (Object.keys(patch).length === 0) return c.json({ error: 'nothing_to_update' }, 400);

  await getDb().update(schema.organizations).set(patch).where(eq(schema.organizations.id, orgId));
  await audit(orgId, userId, 'org.schedule_settings', orgId, patch);

  const [row] = await getDb().select(orgScheduleSettings)
    .from(schema.organizations).where(eq(schema.organizations.id, orgId));
  return c.json({ settings: row });
}));

scheduleRoutes.post('/schedules', guard('member', async (c, { userId, orgId, role }) => {
  const body = asObject(await c.req.json());

  // The name becomes the reports/<job-name>/ directory. Refuse, never sanitize.
  const name = typeof body.name === 'string' ? body.name : '';
  if (!NAME_RE.test(name)) return c.json({ error: 'invalid_name' }, 400);

  const connection = await loadOwnConnection(orgId, body.connectionId, userId, role);
  if (!connection) return c.json({ error: 'forbidden' }, 403);

  const presetId = typeof body.preset === 'string' ? body.preset : null;
  const preset = presetId ? PRESETS[presetId] : undefined;
  if (presetId && !preset) return c.json({ error: 'unknown_preset' }, 400);

  // The briefing preset runs no gbrain command — it is internal to the
  // scheduler, so there is no allowlist entry to validate against.
  const runsCommand = !(preset && preset.operation === null);
  const operation = preset ? (preset.operation ?? preset.id) : String(body.operation ?? '');
  const command = runsCommand ? (SCHEDULER_COMMANDS[operation] ?? null) : null;
  if (runsCommand && !command) return c.json({ error: 'unknown_operation' }, 400);

  // Honesty rule 2: a brain-wide job is not fenceable to a Space.
  if (command && command.scope === 'brain-wide'
    && ROLE_RANK[connection.memberRole] < ROLE_RANK.admin) {
    return c.json({ error: BRAIN_WIDE_ERROR, scope: 'brain-wide' }, 400);
  }

  // Honesty rule 1 in code: fenced params are never accepted from a request.
  let params: Record<string, string | boolean> = {};
  if (command) {
    const merged = { ...(preset?.params ?? {}), ...asObject(body.params) };
    try {
      params = validateParams(command, merged);
    } catch (e) {
      return c.json({ error: errorMessage(e) }, 400);
    }
  }

  const kind = preset?.kind ?? String(body.kind ?? '');
  if (kind !== 'interval' && kind !== 'calendar') return c.json({ error: 'invalid_kind' }, 400);

  const tunables = applyTunables(body, {
    gapPolicy: undefined,
    ambiguousPolicy: undefined,
    catchupPolicy: preset?.defaults.catchupPolicy,
    overlapPolicy: preset?.defaults.overlapPolicy,
    reportPolicy: preset?.defaults.reportPolicy,
  });
  if (!tunables.ok) return c.json({ error: tunables.error }, 400);

  const id = randomUUID();
  const values: typeof schema.schedules.$inferInsert = {
    id,
    organizationId: orgId,
    connectionId: connection.id,
    name,
    preset: preset?.id ?? null,
    operation,
    params,
    kind,
    createdBy: userId,
    ...tunables.values,
  };

  if (kind === 'interval') {
    const intervalSeconds = intOf(body.intervalSeconds, preset?.defaults.intervalSeconds);
    if (intervalSeconds === null || intervalSeconds < 60) {
      return c.json({ error: 'invalid_interval' }, 400);
    }
    if (isSubHourly(intervalSeconds)) {
      const holder = await subHourlyLane(orgId);
      if (holder) {
        return c.json({
          error: 'sub_hourly_limit', holder: holder.name, detail: ONE_LANE_EXPLANATION,
        }, 409);
      }
    }
    values.intervalSeconds = intervalSeconds;
    // The occurrence grid is anchored at creation: an interval schedule with no
    // anchor has no first fire time at all.
    values.anchorAt = new Date();
  } else {
    const hour = intOf(body.calendarHour, preset?.defaults.calendarHour);
    const minute = intOf(body.calendarMinute, preset?.defaults.calendarMinute);
    if (hour === null || hour < 0 || hour > 23 || minute === null || minute < 0 || minute > 59) {
      return c.json({ error: 'invalid_calendar' }, 400);
    }

    let days: number[] | null = null;
    if (body.calendarDaysOfWeek !== undefined && body.calendarDaysOfWeek !== null) {
      if (!isDayList(body.calendarDaysOfWeek)) return c.json({ error: 'invalid_calendar_days' }, 400);
      days = body.calendarDaysOfWeek as number[];
    } else {
      days = preset?.defaults.calendarDaysOfWeek ?? null;
    }

    const decision = assignSlot(minute, hour, days, await calendarFootprints(orgId));
    if (!decision.ok) return c.json({ error: 'slot_taken', nextFree: decision.nextFree }, 409);

    values.calendarHour = hour;
    values.calendarMinute = decision.slotMinute;
    values.calendarDaysOfWeek = days;
    values.slotMinute = decision.slotMinute;
  }

  try {
    await getDb().insert(schema.schedules).values(values);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: 'name_taken' }, 409);
    throw e;
  }

  await audit(orgId, userId, 'schedule.create', id, {
    name, operation, kind, preset: preset?.id ?? null,
    connectionId: connection.id, slotMinute: values.slotMinute ?? null,
  });

  return c.json(await loadScheduleRow(orgId, id), 201);
}));

scheduleRoutes.patch('/schedules/:id', guard('member', async (c, { userId, orgId, role }) => {
  const id = paramOf(c, 'id');
  const body = asObject(await c.req.json());

  const schedule = await loadScheduleRow(orgId, id);
  if (!schedule) return c.json({ error: 'not_found' }, 404);
  if (!ownsConnection(role, userId, await memberUserIdOf(schedule.connectionId))) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const patch: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !NAME_RE.test(body.name)) {
      return c.json({ error: 'invalid_name' }, 400);
    }
    patch.name = body.name;
  }

  if (body.params !== undefined) {
    const command = SCHEDULER_COMMANDS[schedule.operation] ?? null;
    const next = asObject(body.params);
    if (!command) {
      // The briefing takes no params; anything else is a command we do not know.
      if (Object.keys(next).length > 0) return c.json({ error: 'unknown_operation' }, 400);
    } else {
      try {
        patch.params = validateParams(command, next);
      } catch (e) {
        return c.json({ error: errorMessage(e) }, 400);
      }
    }
  }

  if (body.connectionId !== undefined) {
    const connection = await loadOwnConnection(orgId, body.connectionId, userId, role);
    if (!connection) return c.json({ error: 'forbidden' }, 403);
    const command = SCHEDULER_COMMANDS[schedule.operation] ?? null;
    if (command && command.scope === 'brain-wide'
      && ROLE_RANK[connection.memberRole] < ROLE_RANK.admin) {
      return c.json({ error: BRAIN_WIDE_ERROR, scope: 'brain-wide' }, 400);
    }
    patch.connectionId = connection.id;
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'invalid_enabled' }, 400);
    patch.enabled = body.enabled;
    // Re-enabling clears the reason; disabling by hand records why.
    patch.disabledReason = body.enabled ? null : 'operator';
  }

  const tunables = applyTunables(body, NO_PRESET_DEFAULTS);
  if (!tunables.ok) return c.json({ error: tunables.error }, 400);
  Object.assign(patch, tunables.values);

  if (body.intervalSeconds !== undefined) {
    if (schedule.kind !== 'interval') return c.json({ error: 'kind_mismatch' }, 400);
    const intervalSeconds = intOf(body.intervalSeconds);
    if (intervalSeconds === null || intervalSeconds < 60) {
      return c.json({ error: 'invalid_interval' }, 400);
    }
    if (isSubHourly(intervalSeconds)) {
      const holder = await subHourlyLane(orgId, id);
      if (holder) {
        return c.json({
          error: 'sub_hourly_limit', holder: holder.name, detail: ONE_LANE_EXPLANATION,
        }, 409);
      }
    }
    patch.intervalSeconds = intervalSeconds;
  }

  // A calendar change RE-RUNS slot assignment, with this schedule excluded from
  // the grid: moving a job must not collide with itself, and moving it onto a
  // slot someone else holds is refused with the next free one instead of being
  // silently relocated.
  const calendarTouched = body.calendarHour !== undefined
    || body.calendarMinute !== undefined
    || body.calendarDaysOfWeek !== undefined;
  if (calendarTouched) {
    if (schedule.kind !== 'calendar') return c.json({ error: 'kind_mismatch' }, 400);
    const hour = intOf(body.calendarHour, schedule.calendarHour);
    const minute = intOf(body.calendarMinute, schedule.calendarMinute);
    if (hour === null || hour < 0 || hour > 23 || minute === null || minute < 0 || minute > 59) {
      return c.json({ error: 'invalid_calendar' }, 400);
    }

    let days: number[] | null;
    if (body.calendarDaysOfWeek === undefined) days = asDays(schedule.calendarDaysOfWeek);
    else if (body.calendarDaysOfWeek === null) days = null;
    else if (isDayList(body.calendarDaysOfWeek)) days = body.calendarDaysOfWeek as number[];
    else return c.json({ error: 'invalid_calendar_days' }, 400);

    const decision = assignSlot(minute, hour, days, await calendarFootprints(orgId, id));
    if (!decision.ok) return c.json({ error: 'slot_taken', nextFree: decision.nextFree }, 409);

    patch.calendarHour = hour;
    patch.calendarMinute = decision.slotMinute;
    patch.calendarDaysOfWeek = days;
    patch.slotMinute = decision.slotMinute;
  }

  if (Object.keys(patch).length === 0) return c.json({ error: 'nothing_to_update' }, 400);

  try {
    await getDb().update(schema.schedules).set(patch).where(eq(schema.schedules.id, id));
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: 'name_taken' }, 409);
    throw e;
  }

  await audit(orgId, userId, 'schedule.update', id, patch);
  return c.json(await loadScheduleRow(orgId, id));
}));

scheduleRoutes.delete('/schedules/:id', guard('member', async (c, { userId, orgId, role }) => {
  const id = paramOf(c, 'id');
  const schedule = await loadScheduleRow(orgId, id);
  if (!schedule) return c.json({ error: 'not_found' }, 404);
  if (!ownsConnection(role, userId, await memberUserIdOf(schedule.connectionId))) {
    return c.json({ error: 'forbidden' }, 403);
  }

  await getDb().delete(schema.schedules).where(eq(schema.schedules.id, id));
  await audit(orgId, userId, 'schedule.delete', id, {
    name: schedule.name, operation: schedule.operation,
  });
  return c.json({ ok: true });
}));

/**
 * Run history. The projection IS the contract: `summary` is counts and status
 * only (S3c), and no stdout, stderr or argv column is selected even if one is
 * ever added — history must never become a log tail.
 */
scheduleRoutes.get('/schedules/:id/runs', guard('viewer', async (c, { orgId }) => {
  const id = paramOf(c, 'id');
  const schedule = await loadScheduleRow(orgId, id);
  if (!schedule) return c.json({ error: 'not_found' }, 404);

  const runs = await getDb().select({
    id: schema.scheduleRuns.id,
    slot: schema.scheduleRuns.slot,
    fireAt: schema.scheduleRuns.fireAt,
    state: schema.scheduleRuns.state,
    attempt: schema.scheduleRuns.attempt,
    startedAt: schema.scheduleRuns.startedAt,
    finishedAt: schema.scheduleRuns.finishedAt,
    exitCode: schema.scheduleRuns.exitCode,
    classification: schema.scheduleRuns.classification,
    reportPath: schema.scheduleRuns.reportPath,
    summary: schema.scheduleRuns.summary,
    createdAt: schema.scheduleRuns.createdAt,
  })
    .from(schema.scheduleRuns)
    .where(eq(schema.scheduleRuns.scheduleId, id))
    .orderBy(desc(schema.scheduleRuns.fireAt))
    .limit(50);

  return c.json({ runs });
}));

scheduleRoutes.post('/schedules/:id/run-now', guard('member', async (c, { userId, orgId, role }) => {
  const id = paramOf(c, 'id');
  const schedule = await loadScheduleRow(orgId, id);
  if (!schedule) return c.json({ error: 'not_found' }, 404);
  if (!ownsConnection(role, userId, await memberUserIdOf(schedule.connectionId))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  // A disabled schedule has a reason (its Connection was revoked, or an operator
  // paused it). Running it anyway would produce a failed run, not a sync.
  if (!schedule.enabled) {
    return c.json({ error: 'schedule_disabled', reason: schedule.disabledReason }, 409);
  }

  const nowMs = Date.now();
  // Manual runs get a `manual:` slot, never a fabricated scheduled one: history
  // must never claim the scheduler fired something it did not.
  const slot = `manual:${new Date(nowMs).toISOString().slice(0, 19)}Z`;
  try {
    await getDb().insert(schema.scheduleRuns).values({
      id: randomUUID(),
      scheduleId: id,
      organizationId: orgId,
      slot,
      fireAt: new Date(nowMs),
      state: 'pending',
    });
  } catch (e) {
    // UNIQUE (schedule_id, slot) IS the idempotency mechanism: a second click in
    // the same second converges on the same slot and is refused, not duplicated.
    if (isUniqueViolation(e)) return c.json({ error: 'duplicate_run', slot }, 409);
    throw e;
  }

  await audit(orgId, userId, 'schedule.run_now', id, { slot });
  return c.json({ ok: true, run: { scheduleId: id, slot, state: 'pending' } }, 202);
}));
