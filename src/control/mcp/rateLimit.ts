/** Spec Q4: a token bucket per key (the token's hash). In-memory: one
 *  control-plane process; a restart forgives everyone, which is fine. */
export type Limiter = { take(key: string): { ok: true } | { ok: false; retryAfterS: number } };

export function createLimiter(opts: { capacity: number; refillPerSec: number; now?: () => number; maxKeys?: number }): Limiter {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  return {
    take(key) {
      const t = now();
      let b = buckets.get(key);
      if (!b) {
        if (buckets.size >= maxKeys) buckets.clear();
        b = { tokens: opts.capacity, at: t };
        buckets.set(key, b);
      }
      b.tokens = Math.min(opts.capacity, b.tokens + ((t - b.at) / 1000) * opts.refillPerSec);
      b.at = t;
      if (b.tokens < 1) return { ok: false, retryAfterS: Math.max(1, Math.ceil((1 - b.tokens) / opts.refillPerSec)) };
      b.tokens -= 1;
      return { ok: true };
    },
  };
}
