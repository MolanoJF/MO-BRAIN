/**
 * `MODEL_PRICING` — the harness's model spend, priced by us.
 *
 * **Five rates per model, not four.** P9 (`docs/slice-4-findings.md`) read the pinned binary and a
 * real run: Claude Code writes the **1-hour** cache by default
 * (`cache_creation.ephemeral_1h_input_tokens`), and the pricing page charges 2x base input for it
 * against 1.25x for the 5-minute cache. A single `cacheWrite` rate undercounts a run like P2-a by
 * 33.5% — a silent undercount on every run, which is why this table carries both.
 *
 * This is a pinned table with a `pricedAt` date, never a live lookup (D7). A model absent from it is
 * unpriced *by definition*: `priceUsage` returns `null`, and the gateway refuses to forward a call it
 * cannot price. `null` is never `0` — a cost we could not price is not a cost of zero (honesty rule
 * 3, the way gbrain's own `chat_usage_log` writes NULL).
 */

/** USD per **million** tokens. Both cache-write rates are here; see the header. */
export type ModelRate = {
  input: number;
  output: number;
  cacheRead: number;
  /** 1.25x base input, per the pricing page. */
  cacheWrite5m: number;
  /** 2x base input — the one Claude Code actually writes. */
  cacheWrite1h: number;
};

/**
 * Pinned on **2026-09-17** against
 * <https://platform.claude.com/docs/en/about-claude/pricing> (the page P9 read). Per-MTok, USD.
 */
export const MODEL_PRICING = {
  pricedAt: '2026-09-17',
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  /** Keyed by the canonical (undated) model id; `rateFor` also matches a dated id. */
  models: {
    'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
    'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
    'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
    'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  } as const satisfies Record<string, ModelRate>,
} as const;

/** The pin, named once so a caller never re-reads the literal. */
export const PRICED_AT: string = MODEL_PRICING.pricedAt;

/** `claude-haiku-4-5-20251001` -> `claude-haiku-4-5`. The alias `haiku` resolves to a dated id (P2). */
const DATED_SUFFIX = /-\d{8}$/;

/** `null` when the model is not in the pinned table — never a default rate. */
export function rateFor(model: string): ModelRate | null {
  const models: Record<string, ModelRate> = MODEL_PRICING.models;
  const direct = models[model];
  if (direct) return direct;
  const undated = models[model.replace(DATED_SUFFIX, '')];
  return undated ?? null;
}

/**
 * The five counts the table needs. `cacheWrite5m` / `cacheWrite1h` are the split P9 says to read;
 * `cache_creation_input_tokens` is their sum and is the 5m-rate fallback when the split is absent.
 */
export type UsageCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
};

/**
 * Anthropic's wire shape: the `usage` object on an SSE `message_start`/`message_delta`, and the same
 * key on every `assistant` frame's `message.usage` in the harness's `stream-json` output (P2).
 */
export type AnthropicUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
};

/** A count we cannot read is 0 — we never invent tokens from a malformed frame. */
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

export function usageCounts(usage: AnthropicUsage | null | undefined): UsageCounts {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
  }
  const fiveMin = usage.cache_creation?.ephemeral_5m_input_tokens;
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens;
  const splitAbsent = fiveMin == null && oneHour == null;
  return {
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    // Only when the split is absent: the sum, at the 5m rate (P9's rule).
    cacheWrite5mTokens: splitAbsent ? count(usage.cache_creation_input_tokens) : count(fiveMin),
    cacheWrite1hTokens: splitAbsent ? 0 : count(oneHour),
  };
}

const MICRO = 1_000_000;
/** Costs are written to 7 decimals — the harness's own precision on `total_cost_usd`. */
const DECIMALS = 7;

/**
 * Integer micro-USD arithmetic: every rate in the table has at most 2 decimals, so `rate * 1e6` is an
 * exact integer and the sum carries no floating-point drift. Result is USD rounded to 7 decimals.
 */
export function priceCounts(model: string, counts: UsageCounts): number | null {
  const rate = rateFor(model);
  if (!rate) return null;
  const units =
    counts.inputTokens * Math.round(rate.input * MICRO) +
    counts.outputTokens * Math.round(rate.output * MICRO) +
    counts.cacheReadTokens * Math.round(rate.cacheRead * MICRO) +
    counts.cacheWrite5mTokens * Math.round(rate.cacheWrite5m * MICRO) +
    counts.cacheWrite1hTokens * Math.round(rate.cacheWrite1h * MICRO);
  return Math.round((units / (MICRO * MICRO)) * 10 ** DECIMALS) / 10 ** DECIMALS;
}

/**
 * `null` for a model this table cannot price, **never `0`**. Applying it to P2-a's captured frame
 * reproduces the harness's own `total_cost_usd` of `0.0154847` exactly
 * (`test/unit/gateway-pricing.test.ts`).
 */
export function priceUsage(model: string, usage: AnthropicUsage | null | undefined): number | null {
  return priceCounts(model, usageCounts(usage));
}

/** `0.0154847` — the text column's shape. Never `'0'` for an unpriced call; that case is `null`. */
export function formatUsd(cost: number): string {
  return cost.toFixed(DECIMALS);
}
