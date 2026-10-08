import { test, expect } from 'bun:test';
import { verifyOpenAiKey } from '../../src/control/providerCheck.ts';

const KEY = 'sk-unit-test-key-1234567890';
const stub = (status: number) =>
  (async () => new Response('{}', { status })) as unknown as typeof fetch;

test('200 is ok and the key travels only in the Authorization header', async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  const f = (async (url: string, init?: RequestInit) => { seen = { url, init }; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  expect(await verifyOpenAiKey(KEY, f)).toEqual({ ok: true });
  expect(seen!.url).toBe('https://api.openai.com/v1/models');
  expect((seen!.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  expect(seen!.init!.signal).toBeInstanceOf(AbortSignal);
});

test('401 and 403 are invalid_api_key (400)', async () => {
  for (const s of [401, 403]) {
    const r = await verifyOpenAiKey(KEY, stub(s));
    expect(r).toEqual({ ok: false, status: 400, error: 'invalid_api_key' });
    expect(JSON.stringify(r)).not.toContain(KEY);
  }
});

test('5xx is provider_unreachable (502)', async () => {
  const r = await verifyOpenAiKey(KEY, stub(500));
  expect(r).toEqual({ ok: false, status: 502, error: 'provider_unreachable' });
  expect(JSON.stringify(r)).not.toContain(KEY);
});

test('a thrown error is provider_unreachable and never carries the key', async () => {
  const f = (async () => { throw new Error(`connect failed for Bearer ${KEY}`); }) as unknown as typeof fetch;
  const r = await verifyOpenAiKey(KEY, f);
  expect(r).toEqual({ ok: false, status: 502, error: 'provider_unreachable' });
  expect(JSON.stringify(r)).not.toContain(KEY);
});
