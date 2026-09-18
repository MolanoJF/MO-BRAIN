/**
 * The product's name, in one place. Human-facing surfaces render this; the
 * cryptographic domain separators and the compose project name are frozen and
 * deliberately do NOT derive from it (D3/D4).
 */
export const PRODUCT_NAME = 'Mobrain';

export const LIFECYCLE_ORDER = [
  'uninitialized',
  'provider-configured',
  'mode-selected',
  'schema-selected',
  'sources-added',
  'ready',
] as const;

export type Lifecycle = (typeof LIFECYCLE_ORDER)[number];

export function canAdvance(from: Lifecycle, to: Lifecycle): boolean {
  const i = LIFECYCLE_ORDER.indexOf(from);
  const j = LIFECYCLE_ORDER.indexOf(to);
  if (i < 0 || j < 0) return false;
  return j === i || j === i + 1; // same step = idempotent retry
}

export function nextStep(current: Lifecycle): Lifecycle | null {
  const i = LIFECYCLE_ORDER.indexOf(current);
  return i >= 0 && i < LIFECYCLE_ORDER.length - 1 ? LIFECYCLE_ORDER[i + 1]! : null;
}

/**
 * D7: the search-mode cost matrix. `relativeCost` is UPSTREAM'S published
 * claim, never measured on this deployment. `measuredCost` is OURS — produced
 * by `scripts/measure-search-modes.ts` on this stack's own corpus — or `null`
 * when no honest number exists. A surface must render the two differently and
 * must never present upstream's number as one we produced.
 *
 * Measured 2026-09-18 (P5, docs/slice-5-findings.md): every mode's 20-query
 * workload moved the `get_usage` ledger by $0.0000000 over an empty 1-day
 * window on a thin corpus, and the pinned binary refuses two of these three
 * values outright ("Valid options: conservative | balanced | tokenmax"). So
 * every `measuredCost` stays `null` — a 25× claim cannot be validated here.
 */
export const MEASURED_COST_DISCLAIMER =
  'Measured on this deployment\u2019s own corpus. Your ratio depends on page count, ' +
  'chunk size and query shape; re-measure before committing a team to a mode.';

export const SEARCH_MODES = [
  {
    id: 'fast',
    label: 'Fast',
    /** Upstream's published claim. NOT ours — see measuredCost. */
    relativeCost: 1,
    /** Ours, or null. D7: a number we did not produce is never shown as ours. */
    measuredCost: null as number | null,
    measuredAt: null as string | null,
    measuredOn: null as string | null,
    description: 'Lexical + vector retrieval only. Cheapest and lowest latency; no LLM reranking or synthesis on the read path.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    /** Upstream's published claim. NOT ours — see measuredCost. */
    relativeCost: 6,
    measuredCost: null as number | null,
    measuredAt: null as string | null,
    measuredOn: null as string | null,
    description: 'Adds query expansion and reranking. Noticeably better recall on vague questions, at several times the cost per search.',
  },
  {
    id: 'thorough',
    label: 'Thorough',
    /** Upstream's published claim. NOT ours — see measuredCost. */
    relativeCost: 25,
    measuredCost: null as number | null,
    measuredAt: null as string | null,
    measuredOn: null as string | null,
    description: 'Full synthesis over expanded retrieval. Best answers, roughly 25x the cheapest mode — budget for this before enabling it team-wide.',
  },
] as const;
