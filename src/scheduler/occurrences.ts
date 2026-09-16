import {
  gapShiftInstant, localToInstants, slotLabel, wallMsOf, wallOf, type Wall,
} from './time.ts';

const DAY_MS = 86_400_000;

/**
 * A single tick may never materialize more than this. A leader that has been
 * down for a month must fail loudly rather than write 8640 rows; the catch-up
 * policy is what decides how much of that is legitimate, and it runs AFTER
 * enumeration, so enumeration itself needs its own ceiling.
 */
export const MAX_OCCURRENCES_PER_TICK = 2000;

export type Occurrence = { fireAtMs: number; slot: string };

export type IntervalSpec = { kind: 'interval'; intervalSeconds: number; anchorMs: number };

export type CalendarSpec = {
  kind: 'calendar';
  hour: number;
  minute: number;
  /** 0=Sunday .. 6=Saturday in ORG-LOCAL time. null = every day. */
  daysOfWeek: number[] | null;
  /** What to do when the wall time does not exist (spring forward). */
  gapPolicy: 'shift' | 'skip';
  /** What to do when the wall time happens twice (fall back). */
  ambiguousPolicy: 'first' | 'second' | 'both';
};

export type ScheduleSpec = IntervalSpec | CalendarSpec;

/**
 * Anchored real-time recurrence. Computed entirely in UTC, so it is DST-immune
 * by construction: a 5-minute job fires every 5 REAL minutes across both
 * transitions. Only the slot LABEL is timezone-aware.
 */
function intervalOccurrences(
  tz: string, spec: IntervalSpec, fromExclusiveMs: number, toInclusiveMs: number,
): Occurrence[] {
  const step = spec.intervalSeconds * 1000;
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`intervalSeconds must be a positive number, got ${spec.intervalSeconds}`);
  }
  let n = Math.floor((fromExclusiveMs - spec.anchorMs) / step) + 1;
  if (n < 0) n = 0;
  // Math.floor on a negative delta can land exactly on `from`; `from` is exclusive.
  while (spec.anchorMs + n * step <= fromExclusiveMs) n += 1;

  const out: Occurrence[] = [];
  for (let t = spec.anchorMs + n * step; t <= toInclusiveMs; t += step) {
    if (out.length >= MAX_OCCURRENCES_PER_TICK) {
      throw new Error(`too many occurrences in window (cap ${MAX_OCCURRENCES_PER_TICK})`);
    }
    out.push({ fireAtMs: t, slot: slotLabel(tz, t) });
  }
  return out;
}

function dayOfWeek(w: Wall): number {
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
}

/**
 * Wall-clock recurrence. This is where both DST bugs live, and both are
 * resolved by explicit policy rather than by whatever the runtime happens to do.
 */
function calendarOccurrences(
  tz: string, spec: CalendarSpec, fromExclusiveMs: number, toInclusiveMs: number,
): Occurrence[] {
  // Walk local DAYS, padded one either side so a transition-day shift cannot
  // fall out of the window's edge.
  const firstDay = wallOf(tz, fromExclusiveMs - DAY_MS);
  const lastDayMs = wallMsOf(wallOf(tz, toInclusiveMs + DAY_MS));
  const out: Occurrence[] = [];

  for (
    let dayMs = wallMsOf({ ...firstDay, hour: 0, minute: 0 });
    dayMs <= lastDayMs;
    dayMs += DAY_MS
  ) {
    const d = new Date(dayMs);
    const w: Wall = {
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
      hour: spec.hour, minute: spec.minute,
    };
    if (spec.daysOfWeek !== null && !spec.daysOfWeek.includes(dayOfWeek(w))) continue;

    const instants = localToInstants(tz, w);
    let chosen: number[];
    if (instants.length === 0) {
      chosen = spec.gapPolicy === 'skip' ? [] : [gapShiftInstant(tz, w)];
    } else if (instants.length === 2) {
      chosen = spec.ambiguousPolicy === 'first' ? [instants[0]!]
        : spec.ambiguousPolicy === 'second' ? [instants[1]!]
          : instants;
    } else {
      chosen = instants;
    }

    for (const t of chosen) {
      if (t <= fromExclusiveMs || t > toInclusiveMs) continue;
      if (out.length >= MAX_OCCURRENCES_PER_TICK) {
        throw new Error(`too many occurrences in window (cap ${MAX_OCCURRENCES_PER_TICK})`);
      }
      out.push({ fireAtMs: t, slot: slotLabel(tz, t) });
    }
  }
  out.sort((a, b) => a.fireAtMs - b.fireAtMs);
  return out;
}

export function occurrencesIn(
  tz: string, spec: ScheduleSpec, fromExclusiveMs: number, toInclusiveMs: number,
): Occurrence[] {
  return spec.kind === 'interval'
    ? intervalOccurrences(tz, spec, fromExclusiveMs, toInclusiveMs)
    : calendarOccurrences(tz, spec, fromExclusiveMs, toInclusiveMs);
}

export type CatchupPolicy = 'skip' | 'run_latest' | 'run_all';

/**
 * Split enumerated occurrences into what actually runs and what is recorded as
 * deliberately skipped. Default is `skip` (roadmap): after downtime, a brain
 * should not suddenly execute eight hours of backlog.
 *
 * `skipped` occurrences are still PERSISTED, as skipped_catchup rows — "why
 * didn't my job run last night" must be answerable from the run history.
 */
export function applyCatchup(
  occurrences: Occurrence[],
  nowMs: number,
  graceMs: number,
  policy: CatchupPolicy,
  maxRunAll = 50,
): { run: Occurrence[]; skipped: Occurrence[] } {
  const sorted = [...occurrences].sort((a, b) => a.fireAtMs - b.fireAtMs);
  const onTime = sorted.filter((o) => nowMs - o.fireAtMs <= graceMs);
  const missed = sorted.filter((o) => nowMs - o.fireAtMs > graceMs);

  if (policy === 'skip') return { run: onTime, skipped: missed };

  if (policy === 'run_latest') {
    const latest = missed.at(-1);
    return {
      run: [...(latest ? [latest] : []), ...onTime].sort((a, b) => a.fireAtMs - b.fireAtMs),
      skipped: latest ? missed.slice(0, -1) : [],
    };
  }

  // The cap bounds the WHOLE run set, not just the backlog: the test contract is
  // "keep the most recent maxRunAll runs". Occurrences already inside the grace
  // window are due now, so the backlog absorbs the cap first.
  const dropCount = Math.max(0, missed.length - Math.max(0, maxRunAll - onTime.length));
  return {
    run: [...missed.slice(dropCount), ...onTime].sort((a, b) => a.fireAtMs - b.fireAtMs),
    skipped: missed.slice(0, dropCount),
  };
}
