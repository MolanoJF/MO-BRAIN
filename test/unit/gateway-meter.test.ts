import { test, expect, describe, beforeAll } from 'bun:test';
import { StreamMeter, totalTokens } from '../../src/gateway/meter.ts';
import { mintGatewayToken, verifyGatewayToken } from '../../src/gateway/token.ts';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(48);
  process.env.RUNNER_TOKEN = 'runner-token-that-must-not-be-the-token-key';
});

/** P2-a's usage, verbatim from `docs/slice-4-findings.md`. */
const P2A_USAGE = {
  input_tokens: 10,
  cache_creation_input_tokens: 6922,
  cache_read_input_tokens: 13607,
  output_tokens: 54,
  cache_creation: { ephemeral_1h_input_tokens: 6922, ephemeral_5m_input_tokens: 0 },
};

describe('the per-run gateway token', () => {
  test('mints a stateless runId.expiry.mac and verifies it back to the run', () => {
    const token = mintGatewayToken('run-abc', 300);
    expect(token.split('.')).toHaveLength(3);
    expect(token.split('.')[0]).toBe('run-abc');
    expect(verifyGatewayToken(token)).toEqual({ runId: 'run-abc' });
  });

  test('is a pure function of (runId, expiry) — nothing is stored to verify it', () => {
    const now = 1_700_000_000_000;
    expect(mintGatewayToken('run-abc', 300, now)).toBe(mintGatewayToken('run-abc', 300, now));
    expect(mintGatewayToken('run-abc', 300, now)).not.toBe(mintGatewayToken('run-xyz', 300, now));
  });

  test('a token for another run cannot be assembled from a valid one', () => {
    const [runId, expiry, mac] = mintGatewayToken('run-abc', 300).split('.') as [string, string, string];
    expect(verifyGatewayToken(`run-evil.${expiry}.${mac}`)).toBeNull();
    expect(verifyGatewayToken(`${runId}.${Number(expiry) + 1}.${mac}`)).toBeNull();
    expect(verifyGatewayToken(`${runId}.${expiry}.${mac.slice(0, -2)}xx`)).toBeNull();
    expect(verifyGatewayToken(`${runId}.${expiry}.`)).toBeNull();
  });

  test('a malformed or empty token is refused, never half-parsed', () => {
    expect(verifyGatewayToken('')).toBeNull();
    expect(verifyGatewayToken('run-abc')).toBeNull();
    expect(verifyGatewayToken('run-abc.300')).toBeNull();
    expect(verifyGatewayToken('run-abc.notanumber.mac')).toBeNull();
    expect(verifyGatewayToken('.300.mac')).toBeNull();
  });

  test('expiry is enforced, and the boundary is the expiry second', () => {
    const now = 1_700_000_000_000;
    const token = mintGatewayToken('run-abc', 10, now);
    expect(verifyGatewayToken(token, now + 9_000)).toEqual({ runId: 'run-abc' });
    expect(verifyGatewayToken(token, now + 10_000)).toBeNull();
    expect(verifyGatewayToken(token, now + 60_000)).toBeNull();
  });

  test('the signing key is derived from ENCRYPTION_KEY, not from RUNNER_TOKEN', () => {
    const token = mintGatewayToken('run-abc', 300);
    const previous = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'b'.repeat(48);
    expect(verifyGatewayToken(token)).toBeNull();
    process.env.ENCRYPTION_KEY = previous;
    expect(verifyGatewayToken(token)).toEqual({ runId: 'run-abc' });
  });

  test('minting refuses a token that would be meaningless', () => {
    expect(() => mintGatewayToken('', 300)).toThrow('runId is required');
    expect(() => mintGatewayToken('run-abc', 0)).toThrow('ttlSeconds must be positive');
    expect(() => mintGatewayToken('run-abc', Number.NaN)).toThrow('ttlSeconds must be positive');
  });
});

describe('StreamMeter — pricing the frames as they pass', () => {
  test('reproduces P2-a’s cost from the SSE events alone', () => {
    const meter = new StreamMeter({ model: 'claude-haiku-4-5', budgetUsd: 1, accruedUsd: 0 });
    expect(meter.observe({
      type: 'message_start',
      message: { model: 'claude-haiku-4-5-20251001', usage: P2A_USAGE },
    })).toBe('ok');
    expect(meter.observe({
      type: 'message_delta', usage: { output_tokens: 54 }, delta: { stop_reason: 'end_turn' },
    })).toBe('ok');
    expect(meter.pricedCost()).toBe(0.0154847);
    expect(meter.snapshot()).toEqual({
      inputTokens: 10, outputTokens: 54, cacheReadTokens: 13607,
      cacheWrite5mTokens: 0, cacheWrite1hTokens: 6922,
    });
    expect(meter.stopReason).toBe('end_turn');
    expect(totalTokens(meter.snapshot())).toBe(10 + 54 + 13607 + 6922);
  });

  test('the response’s own model id is authoritative, and the alias resolves', () => {
    const meter = new StreamMeter({ model: 'haiku', budgetUsd: 1, accruedUsd: 0 });
    expect(meter.observe({
      type: 'message_start', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 1 } },
    })).toBe('ok');
    expect(meter.pricedCost()).toBe(0.000001);
  });

  test('a huge input context crosses the cap at message_start, before any output', () => {
    // 100k input tokens on Opus 5 ($5/MTok) is $0.50 against a $0.10 cap.
    const meter = new StreamMeter({ model: 'claude-opus-5', budgetUsd: 0.1, accruedUsd: 0 });
    expect(meter.observe({ type: 'message_start', message: { usage: { input_tokens: 100_000 } } }))
      .toBe('cap_crossed');
    expect(meter.crossed).toBe(true);
  });

  test('crosses mid-message on the output byte bound, before message_delta arrives', () => {
    const meter = new StreamMeter({ model: 'claude-haiku-4-5', budgetUsd: 0.00005, accruedUsd: 0 });
    // 10 input tokens = $0.00001, under the cap.
    expect(meter.observe({ type: 'message_start', message: { usage: { input_tokens: 10 } } })).toBe('ok');
    // ~200 bytes of text cannot bill for fewer than 200 tokens: $0.001+, over the cap.
    expect(meter.observe({
      type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(200) },
    })).toBe('cap_crossed');
    expect(meter.crossed).toBe(true);
  });

  test('a delta that stays under the cap is not a crossing — the check is a comparison, not a flag', () => {
    const meter = new StreamMeter({ model: 'claude-haiku-4-5', budgetUsd: 1, accruedUsd: 0 });
    meter.observe({ type: 'message_start', message: { usage: { input_tokens: 10 } } });
    for (let i = 0; i < 5; i += 1) {
      expect(meter.observe({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }))
        .toBe('ok');
    }
    expect(meter.crossed).toBe(false);
  });

  test('the accrued total is part of the comparison, not just this message', () => {
    const meter = new StreamMeter({ model: 'claude-haiku-4-5', budgetUsd: 0.00005, accruedUsd: 0.00005 });
    expect(meter.observe({ type: 'message_start', message: { usage: { input_tokens: 1 } } }))
      .toBe('cap_crossed');
  });

  test('the bound is an over-estimate, never an undercount', () => {
    const meter = new StreamMeter({ model: 'claude-haiku-4-5', budgetUsd: 100, accruedUsd: 0 });
    meter.observe({ type: 'message_start', message: { usage: { input_tokens: 100 } } });
    meter.observe({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'y'.repeat(400) } });
    const bounded = meter.boundedSnapshot();
    meter.observe({ type: 'message_delta', usage: { output_tokens: 12 }, delta: {} });
    // Exact accounting after the fact: the bound billed more tokens than the message really used.
    expect(bounded.counts.outputTokens).toBeGreaterThan(12);
    expect(meter.pricedCost()).toBeLessThan(bounded.costUsd!);
  });

  test('a model the table cannot price is reported, never priced at zero', () => {
    const meter = new StreamMeter({ model: 'claude-haiku-4-5', budgetUsd: 1, accruedUsd: 0 });
    expect(meter.observe({
      type: 'message_start', message: { model: 'claude-nonesuch-9', usage: { input_tokens: 10 } },
    })).toBe('model_unpriced');
    expect(meter.unpricedModel).toBe('claude-nonesuch-9');
  });

  test('a 200 that carried no usage frame is unmeterable — cost null, never 0', () => {
    const meter = new StreamMeter({ model: 'claude-haiku-4-5', budgetUsd: 1, accruedUsd: 0 });
    expect(meter.observe({ type: 'ping' })).toBe('ok');
    expect(meter.sawAnyUsage).toBe(false);
    expect(meter.pricedCost()).toBeNull();
    expect(meter.pricedCost()).not.toBe(0);
  });

  test('junk payloads are ignored rather than crashed on', () => {
    const meter = new StreamMeter({ model: 'claude-haiku-4-5', budgetUsd: 1, accruedUsd: 0 });
    for (const junk of [null, undefined, 'string', 42, []]) {
      expect(meter.observe(junk)).toBe('ok');
    }
    expect(meter.pricedCost()).toBeNull();
  });
});
