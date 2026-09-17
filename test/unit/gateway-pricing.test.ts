import { test, expect, describe } from 'bun:test';
import {
  MODEL_PRICING, PRICED_AT, priceCounts, priceUsage, rateFor, usageCounts,
} from '../../src/gateway/pricing.ts';

/**
 * P2-a's usage, verbatim from `docs/slice-4-findings.md` (the `result` frame of the real run whose
 * `total_cost_usd` was `0.0154847`). The harness wrote the **1-hour** cache, which is the whole reason
 * this table has five rates.
 */
const P2A_USAGE = {
  input_tokens: 10,
  cache_creation_input_tokens: 6922,
  cache_read_input_tokens: 13607,
  output_tokens: 54,
  cache_creation: { ephemeral_1h_input_tokens: 6922, ephemeral_5m_input_tokens: 0 },
};

describe('MODEL_PRICING', () => {
  test('is pinned at a date, with the page it was read from', () => {
    expect(PRICED_AT).toBe('2026-09-17');
    expect(MODEL_PRICING.pricedAt).toBe('2026-09-17');
    expect(MODEL_PRICING.source).toContain('platform.claude.com');
  });

  test('every model carries five rates — a single cache-write rate undercounts 1h writes by 33.5%', () => {
    for (const rate of Object.values(MODEL_PRICING.models)) {
      expect(Object.keys(rate).sort()).toEqual(
        ['cacheRead', 'cacheWrite1h', 'cacheWrite5m', 'input', 'output'],
      );
      expect(rate.cacheWrite5m).toBeCloseTo(rate.input * 1.25, 10);
      expect(rate.cacheWrite1h).toBeCloseTo(rate.input * 2, 10);
      expect(rate.cacheRead).toBeCloseTo(rate.input * 0.1, 10);
    }
  });

  test('the pinned rates are the page’s rates (Haiku 4.5, the model this slice runs)', () => {
    expect(MODEL_PRICING.models['claude-haiku-4-5']).toEqual({
      input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2,
    });
    expect(MODEL_PRICING.models['claude-opus-5']).toEqual({
      input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10,
    });
    expect(MODEL_PRICING.models['claude-sonnet-5']).toEqual({
      input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4,
    });
  });
});

describe('rateFor', () => {
  test('resolves a dated model id to its canonical row', () => {
    expect(rateFor('claude-haiku-4-5-20251001')).toBe(MODEL_PRICING.models['claude-haiku-4-5']);
  });

  test('an unknown model has no rate — never a default', () => {
    expect(rateFor('gpt-4o')).toBeNull();
    expect(rateFor('')).toBeNull();
    expect(rateFor('claude-opus-9')).toBeNull();
  });
});

describe('priceUsage', () => {
  test('reproduces the harness’s own total_cost_usd on P2-a exactly', () => {
    // The captured frame's own number, for the same counts.
    const harnessReported = 0.0154847;
    expect(priceUsage('claude-haiku-4-5-20251001', P2A_USAGE)).toBe(harnessReported);
  });

  test('pricing the 1h write at the 5m rate is the 33.5% undercount P9 measured', () => {
    const fiveMinOnly = priceCounts('claude-haiku-4-5', {
      ...usageCounts(P2A_USAGE), cacheWrite5mTokens: 6922, cacheWrite1hTokens: 0,
    });
    expect(fiveMinOnly).toBe(0.0102932);
    const undercount = 1 - fiveMinOnly! / priceUsage('claude-haiku-4-5', P2A_USAGE)!;
    expect(undercount).toBeGreaterThan(0.33);
    expect(undercount).toBeLessThan(0.34);
  });

  test('an unpriced model is null — never 0', () => {
    expect(priceUsage('claude-nonesuch-9', P2A_USAGE)).toBeNull();
    expect(priceUsage('claude-nonesuch-9', P2A_USAGE)).not.toBe(0);
  });

  test('falls back to the sum at the 5m rate only when the split is absent', () => {
    const noSplit = { input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 0 };
    // 1000 x $1.25/MTok
    expect(priceUsage('claude-haiku-4-5', noSplit)).toBe(0.00125);

    const withSplit = {
      ...noSplit,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
    };
    // 1000 x $2/MTok — the split wins over the sum.
    expect(priceUsage('claude-haiku-4-5', withSplit)).toBe(0.002);
  });

  test('counts a missing usage object as zero, not as unpriced', () => {
    expect(priceUsage('claude-haiku-4-5', null)).toBe(0);
    expect(priceUsage('claude-haiku-4-5', undefined)).toBe(0);
    expect(priceUsage('claude-nonesuch-9', null)).toBeNull();
  });

  test('a malformed count is 0: tokens are never invented from a bad frame', () => {
    expect(usageCounts({
      input_tokens: Number.NaN,
      output_tokens: -5,
      cache_read_input_tokens: 12,
    })).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 12, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
    });
  });

  test('costs are exact at seven decimals, with no floating-point drift', () => {
    // 3 x $1/MTok and 1 x $5/MTok.
    expect(priceUsage('claude-haiku-4-5', { input_tokens: 3, output_tokens: 1 })).toBe(0.000008);
    // A million output tokens is exactly $5.
    expect(priceUsage('claude-haiku-4-5', { output_tokens: 1_000_000 })).toBe(5);
  });
});
