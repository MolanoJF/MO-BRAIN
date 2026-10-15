export const KINDS = ['email', 'calendar', 'meetings', 'docs', 'notes-import', 'fixture'] as const;
export type Kind = (typeof KINDS)[number];
export type Cadence = { kind: 'every'; ms: number } | { kind: 'daily'; hour: number; minute: number } | { kind: 'once' };

export type CollectorConfig = {
  slug: string; source: string; title: string; kind: Kind; enabled: boolean; cadence: Cadence; cadenceText: string;
  harness: string; model: string | null; allowedTools: string[]; targetSource: string; backfillDays: number; timeoutS: number;
};

export type LastRun = { startedAt: Date; finishedAt: Date | null; status: 'running' | 'ok' | 'partial' | 'error' | 'timeout'; timeoutS: number };

const MIN_MS = 15 * 60_000;
const UNIT: Record<string, number> = { m: 60_000, h: 3600_000, d: 86400_000 };

export function parseCadence(text: unknown): Cadence | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === 'once') return { kind: 'once' };
  const every = /^(\d+)([mhd])$/.exec(t);
  if (every) {
    const ms = Number(every[1]) * UNIT[every[2]!]!;
    return ms >= MIN_MS ? { kind: 'every', ms } : null;
  }
  const daily = /^daily@(\d{2}):(\d{2})$/.exec(t);
  if (daily) {
    const hour = Number(daily[1]); const minute = Number(daily[2]);
    return hour < 24 && minute < 60 ? { kind: 'daily', hour, minute } : null;
  }
  return null;
}

export function parseCollector(slug: string, source: string, fm: Record<string, unknown>):
  { ok: true; config: CollectorConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const kind = fm.kind as Kind;
  if (!KINDS.includes(kind)) errors.push('kind');
  const cadence = parseCadence(fm.cadence);
  if (!cadence) errors.push('cadence');
  const tools = Array.isArray(fm.allowed_tools) ? fm.allowed_tools.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  if (kind !== 'fixture' && tools.length === 0) errors.push('allowed_tools');
  const target = typeof fm.target_source === 'string' ? fm.target_source : source;
  if (target !== source) errors.push('target_source');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: {
      slug, source, kind, cadence: cadence!, cadenceText: String(fm.cadence),
      title: typeof fm.title === 'string' ? fm.title : slug.split('/').pop()!,
      enabled: fm.enabled !== false,
      harness: typeof fm.harness === 'string' ? fm.harness : 'claude-code',
      model: typeof fm.model === 'string' ? fm.model : null,
      allowedTools: tools,
      targetSource: target,
      backfillDays: typeof fm.backfill_days === 'number' ? fm.backfill_days : 90,
      timeoutS: typeof fm.timeout_s === 'number' ? fm.timeout_s : 1200,
    },
  };
}

/** A running row past its timeout counts as finished (timeout) at start + timeout. */
function effectiveFinish(run: LastRun, now: Date): Date | null {
  if (run.status !== 'running') return run.finishedAt;
  const deadline = new Date(run.startedAt.getTime() + run.timeoutS * 1000);
  return deadline <= now ? deadline : null;
}

export function nextDue(c: CollectorConfig, last: LastRun | null, now: Date): Date | null {
  if (!c.enabled) return null;
  if (!last) return now;
  const finished = effectiveFinish(last, now);
  if (!finished) return null; // genuinely running
  if (c.cadence.kind === 'once') return last.status === 'ok' ? null : now;
  if (c.cadence.kind === 'every') return new Date(finished.getTime() + c.cadence.ms);
  const today = new Date(now); today.setHours(c.cadence.hour, c.cadence.minute, 0, 0);
  if (finished < today) return today;
  const tomorrow = new Date(today.getTime() + 86400_000);
  return tomorrow;
}

export function isDue(c: CollectorConfig, last: LastRun | null, now: Date): boolean {
  const n = nextDue(c, last, now);
  return n !== null && n <= now;
}
