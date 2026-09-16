/**
 * Upstream's staggering convention, made structural.
 *
 *   skills/cron-scheduler/SKILL.md:26,36 —
 *     "Schedule staggering: max 1 job per 5-minute slot, no collisions"
 *     "Slots: :05, :10, :15, :20, :25, :30, :35, :40, :45, :50"
 *     "If collision detected, suggest the next available slot"
 *   ... and its named anti-pattern: "Scheduling jobs at the same minute
 *   (:00 for everything)".
 *
 * This grid governs CALENDAR schedules. A sub-hourly interval schedule
 * mathematically occupies every slot (5 divides 60), so the grid cannot apply
 * to it; upstream itself recommends exactly one such line
 * (`*\/5 * * * * gbrain sync --all ...`, SKILL.md:65). That is enforced
 * elsewhere as "at most one enabled sub-hourly schedule per org".
 */
export const ASSIGNABLE_SLOTS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50] as const;

export const SUB_HOURLY_SECONDS = 3600;

export function isSubHourly(intervalSeconds: number): boolean {
  return intervalSeconds < SUB_HOURLY_SECONDS;
}

export type CalendarFootprint = {
  slotMinute: number;
  hour: number;
  /** 0=Sunday .. 6=Saturday, org-local. null = every day. */
  daysOfWeek: number[] | null;
};

/** Round UP to the next assignable slot; :51-:59 clamp back to :50, never :00. */
export function snapToSlot(minute: number): number {
  for (const s of ASSIGNABLE_SLOTS) if (minute <= s) return s;
  return ASSIGNABLE_SLOTS[ASSIGNABLE_SLOTS.length - 1]!;
}

export function footprintsCollide(a: CalendarFootprint, b: CalendarFootprint): boolean {
  if (a.slotMinute !== b.slotMinute) return false;
  if (a.hour !== b.hour) return false;
  if (a.daysOfWeek === null || b.daysOfWeek === null) return true;
  return a.daysOfWeek.some((d) => b.daysOfWeek!.includes(d));
}

export type SlotDecision =
  | { ok: true; slotMinute: number }
  | { ok: false; nextFree: number | null };

/**
 * Refuse a colliding schedule and offer the next free slot — never silently
 * relocate it. The caller surfaces `nextFree` in a 409 so the operator makes
 * the choice.
 */
export function assignSlot(
  requestedMinute: number,
  hour: number,
  daysOfWeek: number[] | null,
  taken: CalendarFootprint[],
): SlotDecision {
  const start = snapToSlot(requestedMinute);
  const free = (slotMinute: number): boolean =>
    !taken.some((t) => footprintsCollide({ slotMinute, hour, daysOfWeek }, t));

  if (free(start)) return { ok: true, slotMinute: start };

  const startIndex = ASSIGNABLE_SLOTS.indexOf(start as (typeof ASSIGNABLE_SLOTS)[number]);
  for (let i = 1; i < ASSIGNABLE_SLOTS.length; i++) {
    const candidate = ASSIGNABLE_SLOTS[(startIndex + i) % ASSIGNABLE_SLOTS.length]!;
    if (free(candidate)) return { ok: false, nextFree: candidate };
  }
  return { ok: false, nextFree: null };
}
