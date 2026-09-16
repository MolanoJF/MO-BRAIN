/**
 * Per-org IANA timezone math with explicit DST handling. No dependency:
 * everything derives from Intl.DateTimeFormat, which is the only timezone
 * database Bun ships. Temporal is not available at this Bun version.
 *
 * The two bugs this file exists to prevent are both real and both annual:
 * a wall-clock time that does not exist (spring forward) and one that
 * happens twice (fall back).
 */
const DAY_MS = 86_400_000;
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export type Wall = { year: number; month: number; day: number; hour: number; minute: number };

/**
 * Intl happily accepts 'EST' and 'PST8PDT'. Those are fixed-offset or legacy
 * aliases, not the per-org IANA zones the scheduler promises, so require a
 * region/city id (or literal UTC).
 */
export function isValidTimeZone(tz: string): boolean {
  if (tz !== 'UTC' && !tz.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The instant's wall clock in `tz`, encoded as the UTC epoch of those fields. */
export function zonedWallMs(tz: string, instantMs: number): number {
  const parts = fmt(tz).formatToParts(new Date(instantMs));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`missing ${type} part for ${tz}`);
    return Number(p.value);
  };
  // Some ICU builds emit "24" for midnight under hour12:false.
  const hour = get('hour') % 24;
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
}

export function offsetMs(tz: string, instantMs: number): number {
  return zonedWallMs(tz, instantMs) - instantMs;
}

export function wallOf(tz: string, instantMs: number): Wall {
  const d = new Date(zonedWallMs(tz, instantMs));
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(),
  };
}

export function wallMsOf(w: Wall): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0);
}

/**
 * Resolve a local wall time to instants:
 *   []        the time does not exist (spring-forward gap)
 *   [t]       the normal case
 *   [t1, t2]  the time happens twice (fall back), ascending
 * Probing one day either side samples both candidate UTC offsets around any
 * transition; a candidate is real only if formatting it back reproduces the
 * requested wall clock.
 */
export function localToInstants(tz: string, w: Wall): number[] {
  const target = wallMsOf(w);
  const found = new Set<number>();
  for (const probe of [target - DAY_MS, target + DAY_MS]) {
    const candidate = target - offsetMs(tz, probe);
    if (zonedWallMs(tz, candidate) === target) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Gap resolution, Temporal's `compatible` rule: interpret the nonexistent wall
 * time with the PRE-transition offset, which shifts it forward by exactly the
 * gap. 02:30 on a spring-forward day becomes 03:30 local.
 */
export function gapShiftInstant(tz: string, w: Wall): number {
  const target = wallMsOf(w);
  return target - offsetMs(tz, target - DAY_MS);
}

/** 2 when this instant is the SECOND pass through an ambiguous hour, else 1. */
export function ambiguousPass(tz: string, instantMs: number): 1 | 2 {
  const candidates = localToInstants(tz, wallOf(tz, instantMs));
  return candidates.length === 2 && instantMs === candidates[1] ? 2 : 1;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The idempotency slot (roadmap: key = schedule_id + slot). A wall stamp, plus
 * '#2' on the second pass of an ambiguous hour — without which a 5-minute
 * schedule would silently lose an hour of runs every fall-back.
 */
export function slotLabel(tz: string, instantMs: number): string {
  const w = wallOf(tz, instantMs);
  const base = `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
  return ambiguousPass(tz, instantMs) === 2 ? `${base}#2` : base;
}

/** Upstream's output convention: reports/<job-name>/<YYYY-MM-DD-HHMM>.md */
export function reportStamp(tz: string, instantMs: number): string {
  const w = wallOf(tz, instantMs);
  const base = `${w.year}-${pad(w.month)}-${pad(w.day)}-${pad(w.hour)}${pad(w.minute)}`;
  return ambiguousPass(tz, instantMs) === 2 ? `${base}-2` : base;
}

/** Org-local quiet hours. `start > end` wraps midnight (the 23:00-08:00 default). */
export function inQuietHours(
  tz: string, instantMs: number, startHour: number, endHour: number,
): boolean {
  const h = wallOf(tz, instantMs).hour;
  return startHour <= endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}
