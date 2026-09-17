import { test, expect, describe, afterEach } from 'bun:test';
import {
  bannerFor, confirmBlockedFor, connectionLine, conflictMessage, slotHolder,
  subHourlyMessage, laneHolderId, commandScope, runStateLabel, runStateTone,
  runReason, alertLabel, alertTone, pinnedAlerts, isPinnedAlert, quietHoursBadge,
  holdBadge, hhmm,
} from '../../src/console/pages/Schedules.tsx';
import { api, ApiError, scheduleApi } from '../../src/console/api.ts';
import { AGENT_ALERT_KINDS } from '../../src/agent/alerts.ts';

const STATES = [
  'pending', 'running', 'succeeded', 'failed', 'blocked', 'cancelled',
  'lease_expired', 'skipped_overlap', 'skipped_catchup', 'held',
];

const SETTINGS = { timezone: 'America/New_York', quietHoursStart: 23, quietHoursEnd: 8 };

const CTX = {
  catchupPolicy: 'skip', overlapPolicy: 'skip', misfireGraceSeconds: 120,
  quietHours: SETTINGS,
};

describe('the scope honesty banners', () => {
  test('a brain-wide command renders the whole-brain banner', () => {
    expect(bannerFor({ scope: 'brain-wide', writeSpace: 'shared' }))
      .toContain('reads the whole brain, not just shared');
  });

  test('a source-scoped command renders the control-lane disclosure', () => {
    expect(bannerFor({ scope: 'source', writeSpace: 'shared' }))
      .toContain('not a permission gbrain enforces');
  });

  test('a brain-wide banner never claims gbrain enforces the fence', () => {
    const banner = bannerFor({ scope: 'brain-wide', writeSpace: 'shared' });
    expect(banner).not.toContain('not a permission gbrain enforces');
    expect(banner).toMatch(/admin/);
  });

  test('a brain-wide confirm is blocked on a member Connection, allowed on an admin one', () => {
    expect(confirmBlockedFor({ scope: 'brain-wide', memberRole: 'member' })).toBe(true);
    expect(confirmBlockedFor({ scope: 'brain-wide', memberRole: 'viewer' })).toBe(true);
    expect(confirmBlockedFor({ scope: 'brain-wide', memberRole: 'admin' })).toBe(false);
    expect(confirmBlockedFor({ scope: 'brain-wide', memberRole: 'owner' })).toBe(false);
    expect(confirmBlockedFor({ scope: 'source', memberRole: 'member' })).toBe(false);
    // An unknown scope must never pass as fenceable — block, do not assume.
    expect(confirmBlockedFor({ scope: null, memberRole: 'owner' })).toBe(true);
    expect(confirmBlockedFor({ scope: 'something-new', memberRole: 'owner' })).toBe(true);
  });

  test('the scheduler allowlist is the single source of truth for scope', () => {
    expect(commandScope('doctor')).toBe('brain-wide');
    expect(commandScope('sync')).toBe('source');
    expect(commandScope('sources-push')).toBe('source');
    expect(commandScope('not-a-command')).toBe(null);
    expect(commandScope(null)).toBe(null);
  });
});

describe('the Connection mental model', () => {
  test('a schedule renders runs-as / writes-to, never a Member', () => {
    expect(connectionLine({ clientName: 'claude-desktop', writeSpace: 'shared' }))
      .toBe('runs as claude-desktop · writes to shared');
  });

  test('a schedule with no Connection says so instead of naming a Member', () => {
    const line = connectionLine(null);
    expect(line).toContain('no Connection');
    expect(line).not.toContain('runs as');
  });
});

describe('a refusal is a choice, never a raw error', () => {
  test('a slot conflict renders the holder and the next free slot', () => {
    expect(conflictMessage(
      { error: 'slot_taken', nextFree: 10, requested: { hour: 2, minute: 5 } },
      'nightly-dream',
    )).toBe('02:05 is taken by nightly-dream. Next free: 02:10');
  });

  test('a fully booked hour says so rather than offering a wrong slot', () => {
    const msg = conflictMessage(
      { error: 'slot_taken', nextFree: null, requested: { hour: 2, minute: 5 } },
      'nightly-dream',
    );
    expect(msg).toContain('02:05 is taken by nightly-dream');
    expect(msg).toMatch(/no free slot/i);
  });

  test('the colliding schedule is found so the choice can be offered', () => {
    const schedules = [
      { name: 'nightly-dream', kind: 'calendar', calendarHour: 2, calendarMinute: 5, calendarDaysOfWeek: null },
      { name: 'weekly-health', kind: 'calendar', calendarHour: 6, calendarMinute: 10, calendarDaysOfWeek: [1] },
      { name: 'edge-sync', kind: 'calendar', calendarHour: 2, calendarMinute: 50, calendarDaysOfWeek: null },
    ];
    expect(slotHolder(schedules, { hour: 2, minute: 5 })).toBe('nightly-dream');
    expect(slotHolder(schedules, { hour: 2, minute: 10 })).toBe(null);
    // The requested minute snaps onto the :05…:50 grid, so :00 becomes :05 and
    // :55 becomes :50 — the console and the server must agree on that grid.
    expect(slotHolder(schedules, { hour: 2, minute: 0 })).toBe('nightly-dream');
    expect(slotHolder(schedules, { hour: 2, minute: 55 })).toBe('edge-sync');
    // Disjoint day footprints do not collide; intersecting ones do.
    expect(slotHolder(schedules, { hour: 6, minute: 10, daysOfWeek: [3] })).toBe(null);
    expect(slotHolder(schedules, { hour: 6, minute: 10, daysOfWeek: [1] })).toBe('weekly-health');
    // An interval schedule occupies no calendar slot at all.
    expect(slotHolder([{ name: 'live-sync', kind: 'interval' }], { hour: 2, minute: 5 })).toBe(null);
    // A schedule being edited never collides with itself.
    expect(slotHolder(schedules, { hour: 2, minute: 5 }, 'nightly-dream')).toBe(null);
  });

  test('the sub-hourly refusal explains the lane and names the holder', () => {
    const msg = subHourlyMessage({
      error: 'sub_hourly_limit', holder: 'live-sync',
      detail: 'A sub-hourly schedule occupies every 5-minute stagger slot.',
    });
    expect(msg).toContain('live-sync');
    expect(msg).toMatch(/stagger slot/i);
    // The one-lane rule is upstream's "don't over-cron", not an arbitrary cap.
    expect(msg).toMatch(/hour or more/i);
  });

  test('the remedy the server already states is not repeated back at the operator', () => {
    const detail = 'A sub-hourly schedule occupies every 5-minute stagger slot, so it cannot be '
      + 'staggered against another one. Disable the schedule holding the lane, or give this one an '
      + 'interval of an hour or more.';
    const msg = subHourlyMessage({ holder: 'live-sync', detail });
    expect(msg.match(/hour or more/g)).toHaveLength(1);
    expect(msg).toContain('Disable the schedule holding the lane');
  });

  test('the sub-hourly holder is one click away, by id', () => {
    const schedules = [
      { id: 's1', name: 'live-sync', kind: 'interval' },
      { id: 's2', name: 'nightly-dream', kind: 'calendar' },
    ];
    expect(laneHolderId(schedules, 'live-sync')).toBe('s1');
    expect(laneHolderId(schedules, 'gone')).toBe(null);
  });
});

describe('run history', () => {
  test('every run state has a human label — no raw enum reaches the UI', () => {
    for (const s of STATES) {
      expect(runStateLabel(s)).not.toBe(s);
      expect(runStateLabel(s).length).toBeGreaterThan(0);
      expect(runStateLabel(s)).not.toContain('_');
    }
  });

  test('the ten states are labelled distinctly', () => {
    const labels = STATES.map(runStateLabel);
    expect(new Set(labels).size).toBe(STATES.length);
  });

  test('a partial or unknown outcome is never rendered green', () => {
    // Slice 2 honesty rule 5, carried forward: a passing server check is not proof.
    for (const s of ['held', 'skipped_overlap', 'lease_expired', 'blocked']) {
      expect(runStateTone(s)).not.toBe('ok');
    }
    expect(runStateTone('succeeded')).toBe('ok');
    // A state this console has never heard of is not an "ok" either.
    expect(runStateTone('some_new_state')).not.toBe('ok');
    expect(runStateLabel('some_new_state')).not.toContain('_');
  });

  test('"why did my job not run last night" is answered for every skip', () => {
    expect(runReason({ state: 'skipped_catchup' }, CTX)).toMatch(/catch-up policy/i);
    expect(runReason({ state: 'skipped_overlap' }, CTX)).toMatch(/overlap policy/i);
    expect(runReason({ state: 'skipped_overlap', classification: 'refused' }, CTX))
      .toMatch(/disabled/i);
    expect(runReason({ state: 'held' }, CTX)).toMatch(/quiet hours/i);
  });

  test('every non-succeeded outcome carries a one-line reason', () => {
    const explained = ['failed', 'blocked', 'cancelled', 'lease_expired',
      'skipped_overlap', 'skipped_catchup', 'held'];
    for (const s of explained) {
      expect(runReason({ state: s }, CTX)).toBeTruthy();
    }
    // A run that did what it said needs no excuse line.
    expect(runReason({ state: 'succeeded' }, CTX)).toBe(null);
    expect(runReason({ state: 'pending' }, CTX)).toBe(null);
  });

  test('a held run names the org window and the IANA zone it is in', () => {
    const reason = runReason({ state: 'held' }, CTX);
    expect(reason).toContain('23:00');
    expect(reason).toContain('08:00');
    expect(reason).toContain('America/New_York');
  });

  test('an expired lease is never described as retried', () => {
    // Honesty rule 6: a half-finished dream costs real money.
    expect(runReason({ state: 'lease_expired', classification: 'failed' }, CTX))
      .toMatch(/never retried|not retried/i);
  });

  test('a skipped_catchup reason names the policy that skipped it', () => {
    expect(runReason({ state: 'skipped_catchup' }, { ...CTX, catchupPolicy: 'run_latest' }))
      .toContain('run_latest');
  });
});

describe('quiet hours are visible', () => {
  test('the org window renders in org-local time with its zone named', () => {
    expect(quietHoursBadge(SETTINGS)).toBe('output held 23:00–08:00 America/New_York');
  });

  test('an unreadable window says so instead of inventing one', () => {
    expect(quietHoursBadge(null)).toMatch(/unknown/i);
  });

  test('only a notifying schedule is badged', () => {
    expect(holdBadge({ notifies: true }, SETTINGS))
      .toBe('output held 23:00–08:00 America/New_York');
    expect(holdBadge({ notifies: false }, SETTINGS)).toBe(null);
    // Notifies with no readable window is still badged, honestly.
    expect(holdBadge({ notifies: true }, null)).toMatch(/unknown/i);
  });

  test('hours are padded so a window reads as a wall clock', () => {
    expect(hhmm(8, 5)).toBe('08:05');
    expect(hhmm(23, 0)).toBe('23:00');
  });
});

describe('alerts are unmissable and acknowledgeable', () => {
  const alert = (id: string, kind: string, acknowledgedAt: string | null) => ({
    id, kind, acknowledgedAt, at: '2026-09-15T10:00:00.000Z', scheduleId: 's1', runId: null,
    detail: null, acknowledgedBy: null,
  });

  test('an open pinned alert is missable never: it is pinned and labelled in words', () => {
    const alerts = [
      alert('1', 'push_rejected', null),
      alert('2', 'run_ok', '2026-09-15T09:00:00.000Z'),
      alert('3', 'push_rejected', '2026-09-15T09:30:00.000Z'),
    ];
    expect(pinnedAlerts(alerts).map((a) => a.id)).toEqual(['1']);
    expect(alertLabel('push_rejected')).not.toBe('push_rejected');
    expect(alertLabel('push_rejected')).not.toContain('_');
  });

  test('every pinned kind is pinned for the right reason', () => {
    for (const kind of ['push_blocked', 'lease_expired', 'connection_revoked']) {
      expect(pinnedAlerts([alert('x', kind, null)]).map((a) => a.id)).toEqual(['x']);
      expect(alertTone(kind)).toBe('danger');
    }
  });

  test('the pinned predicate is the one the Health page filters by', () => {
    // The Health page reads kinds only — it never sees `acknowledgedAt`.
    for (const kind of ['push_rejected', 'push_blocked', 'lease_expired', 'connection_revoked']) {
      expect(isPinnedAlert(kind)).toBe(true);
    }
    expect(isPinnedAlert('run_ok')).toBe(false);
    expect(isPinnedAlert('run_failed')).toBe(false);
  });

  test('an unknown alert kind is still rendered as words, never as an enum', () => {
    expect(alertLabel('some_new_alert')).not.toContain('_');
    expect(alertTone('some_new_alert')).not.toBe('ok');
  });

  // Task 11's seam. `schedule_alerts.kind` is free text with no CHECK, so the
  // only thing standing between a new kind and a shrug is the hand-maintained
  // tables in this page — an unregistered kind falls through to the warning
  // tone and the de-underscored label, which reads as an enum and hides the
  // money.
  test('every agent alert kind the lane can raise is registered by hand', () => {
    for (const kind of Object.values(AGENT_ALERT_KINDS)) {
      expect(alertLabel(kind)).not.toBe(kind);
      expect(alertLabel(kind)).not.toBe(kind.replaceAll('_', ' '));
      expect(alertLabel(kind)).not.toContain('_');
    }
  });

  test('the two agent alerts that stopped work are danger, not the warning default', () => {
    expect(alertTone(AGENT_ALERT_KINDS.budgetExceeded)).toBe('danger');
    expect(alertTone(AGENT_ALERT_KINDS.runFailed)).toBe('danger');
    // D11 says "never retry" for both, so neither can be a shrug.
    expect(alertTone('agent_budget_exceeded')).not.toBe('warning');
  });
});

const orig = globalThis.fetch;
afterEach(() => { globalThis.fetch = orig; });

const stub = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
};

const capture = (status = 200, body: unknown = {}) => {
  const seen: { url: string; method: string } = { url: '', method: '' };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.url = url; seen.method = init?.method ?? 'GET';
    return new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return seen;
};

describe('the schedule api client', () => {
  test('list reads the schedules envelope', async () => {
    const seen = capture(200, { schedules: [] });
    await scheduleApi.list();
    expect(seen.url).toBe('/api/schedules');
    expect(seen.method).toBe('GET');
  });

  test('a refusal keeps its parsed body, not just the message', async () => {
    // Requirement 4/5: the console needs `nextFree`/`holder` to offer a choice.
    stub(409, { error: 'slot_taken', nextFree: 10 });
    const err = await scheduleApi.create({ name: 'x', connectionId: 'c' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).body).toEqual({ error: 'slot_taken', nextFree: 10 });
  });

  test('settings are read with GET and written with PATCH', async () => {
    const read = capture(200, { settings: SETTINGS });
    await scheduleApi.settings();
    expect(read.url).toBe('/api/org/schedule-settings');
    expect(read.method).toBe('GET');

    const write = capture(200, { settings: SETTINGS });
    await scheduleApi.saveSettings({ timezone: 'America/New_York' });
    expect(write.url).toBe('/api/org/schedule-settings');
    expect(write.method).toBe('PATCH');
  });

  test('history, acknowledge and run-now address the right resources', async () => {
    const runs = capture(200, { runs: [] });
    await scheduleApi.runs('sch 1');
    expect(runs.url).toBe('/api/schedules/sch%201/runs');

    const ack = capture(200, { ok: true });
    await scheduleApi.acknowledge('a1');
    expect(ack.url).toBe('/api/schedule-alerts/a1/ack');
    expect(ack.method).toBe('POST');

    const now = capture(202, { ok: true, run: {} });
    await scheduleApi.runNow('sch1');
    expect(now.url).toBe('/api/schedules/sch1/run-now');
    expect(now.method).toBe('POST');
  });

  test('the presets envelope and the alert envelope are distinct reads', async () => {
    const presets = capture(200, { presets: [], system: [] });
    await scheduleApi.presets();
    expect(presets.url).toBe('/api/schedule-presets');

    const alerts = capture(200, { alerts: [] });
    await scheduleApi.alerts();
    expect(alerts.url).toBe('/api/schedule-alerts');

    // The generic client is still the one doing the work.
    expect(typeof api.get).toBe('function');
  });
});
