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
 * V4: the search-mode cost matrix is a post-init `config set search.mode`.
 * relativeCost is a multiple of the cheapest mode — render it as a number the
 * admin can reason about, not a shrug. Confirm the real values against
 * `gbrain config list` output during Slice 0 and update them here.
 */
export const SEARCH_MODES = [
  {
    id: 'fast',
    label: 'Fast',
    relativeCost: 1,
    description: 'Lexical + vector retrieval only. Cheapest and lowest latency; no LLM reranking or synthesis on the read path.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    relativeCost: 6,
    description: 'Adds query expansion and reranking. Noticeably better recall on vague questions, at several times the cost per search.',
  },
  {
    id: 'thorough',
    label: 'Thorough',
    relativeCost: 25,
    description: 'Full synthesis over expanded retrieval. Best answers, roughly 25x the cheapest mode — budget for this before enabling it team-wide.',
  },
] as const;
