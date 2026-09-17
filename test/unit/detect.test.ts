import { test, expect, describe } from 'bun:test';
import { detectUpdate } from '../../src/upgrade/detect.ts';
import type { CheckUpdateResult } from '../../src/upgrade/detect.ts';

const base: CheckUpdateResult = {
  current_version: '0.50.0.0', current_source: 'package-json',
  latest_version: '0.50.0.0', update_available: false,
  upgrade_command: 'gbrain upgrade', release_url: '', changelog_diff: '', published_at: '',
};

describe('detectUpdate', () => {
  test('an update available surfaces as a CANDIDATE, never a vetted release', () => {
    const result = detectUpdate({ ...base, update_available: true, latest_version: '0.50.5.0' });
    expect(result.status).toBe('available');
    expect(result.candidateVersion).toBe('0.50.5.0');
    expect(result.error).toBeNull();
  });

  test('up to date is reported only when update_available is false AND there is no error', () => {
    const result = detectUpdate(base);
    expect(result.status).toBe('up_to_date');
    expect(result.candidateVersion).toBeNull();
  });

  // Honesty rule 1: a check that never ran is not a pass.
  test('a network error surfaces as unknown, never as up to date', () => {
    const result = detectUpdate({ ...base, error: 'network_error' });
    expect(result.status).toBe('unknown');
    expect(result.error).toBe('network_error');
    expect(result.candidateVersion).toBeNull();
  });

  test('a malformed payload is unknown, not a thrown exception', () => {
    expect(detectUpdate(null).status).toBe('unknown');
    expect(detectUpdate(null).error).toBe('malformed_response');
    expect(detectUpdate({}).status).toBe('unknown');
    expect(detectUpdate(undefined).status).toBe('unknown');
  });

  // U2: published_at is always '' — the field exists to NOT be rendered.
  test('published_at never appears in the classified result', () => {
    const result = detectUpdate({ ...base, update_available: true, latest_version: '0.50.5.0' });
    expect(Object.keys(result)).not.toContain('published_at');
  });
});
