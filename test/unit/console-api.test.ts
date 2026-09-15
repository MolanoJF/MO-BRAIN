import { test, expect, describe, afterEach } from 'bun:test';
import { api, ApiError } from '../../src/console/api.ts';

const orig = globalThis.fetch;
afterEach(() => { globalThis.fetch = orig; });

const stub = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
};

describe('console api client', () => {
  test('returns the parsed body on success', async () => {
    stub(200, { lifecycle: 'uninitialized' });
    const body = await api.get<{ lifecycle: string }>('/wizard/state');
    expect(body).toEqual({ lifecycle: 'uninitialized' });
  });

  test('throws ApiError carrying status and message', async () => {
    stub(409, { error: 'cannot advance from uninitialized to schema-selected' });
    const err = await api.post('/wizard/schema', { pack: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toMatch(/cannot advance/);
  });

  test('prefixes every path with /api', async () => {
    let seen = '';
    globalThis.fetch = (async (url: string) => {
      seen = url;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await api.get('/wizard/state');
    expect(seen).toBe('/api/wizard/state');
  });

  test('sends credentials so the session cookie travels', async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_u: string, i: RequestInit) => {
      init = i;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await api.get('/wizard/state');
    expect(init?.credentials).toBe('same-origin');
  });
});
