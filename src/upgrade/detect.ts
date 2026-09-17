export type CheckUpdateResult = {
  current_version: string;
  current_source: 'package-json';
  latest_version: string;
  update_available: boolean;
  upgrade_command: string;
  release_url: string;
  changelog_diff: string;
  /** ALWAYS '' at this pin (U2) — the source has no timestamp. Never render it. */
  published_at: string;
  error?: 'network_error' | 'no_releases';
};

export type DetectStatus = 'up_to_date' | 'available' | 'unknown';

export type DetectResult = {
  status: DetectStatus;
  error: 'network_error' | 'no_releases' | 'malformed_response' | null;
  currentVersion: string | null;
  /** Upstream's master VERSION file — a candidate, never a vetted release
   *  (U2, D7). An operator selects it explicitly; nothing here auto-upgrades. */
  candidateVersion: string | null;
  changelog: string | null;
  releaseUrl: string | null;
};

/**
 * Pure and synchronous: classifies an ALREADY-FETCHED check-update body. It
 * never calls the RPC itself and it never branches on an exit code (U1) —
 * check-update always exits 0, even on failure, so `.error` is the only
 * trustworthy signal.
 */
export function detectUpdate(body: unknown): DetectResult {
  const b = body as Partial<CheckUpdateResult> | null | undefined;
  if (!b || typeof b.current_version !== 'string') {
    return {
      status: 'unknown', error: 'malformed_response', currentVersion: null,
      candidateVersion: null, changelog: null, releaseUrl: null,
    };
  }
  if (b.error) {
    // Honesty rule 1: a check that never ran is not a pass. Never fall
    // through to "up to date" just because update_available reads false.
    return {
      status: 'unknown', error: b.error, currentVersion: b.current_version,
      candidateVersion: null, changelog: null, releaseUrl: null,
    };
  }
  if (!b.update_available) {
    return {
      status: 'up_to_date', error: null, currentVersion: b.current_version,
      candidateVersion: null, changelog: null, releaseUrl: null,
    };
  }
  return {
    status: 'available', error: null, currentVersion: b.current_version,
    candidateVersion: b.latest_version ?? null,
    changelog: b.changelog_diff ?? null, releaseUrl: b.release_url ?? null,
  };
}
