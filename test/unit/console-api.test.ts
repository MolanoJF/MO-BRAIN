import { test, expect, describe, afterEach } from 'bun:test';
import { api, ApiError, runApi, toDiffSummary, toRunnerStatus, toSpaceHeads } from '../../src/console/api.ts';

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

  test('delete prefixes the path with /api and uses DELETE', async () => {
    let seen = '';
    let method = '';
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen = url;
      method = init?.method ?? '';
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await api.delete('/members/abc');
    expect(seen).toBe('/api/members/abc');
    expect(method).toBe('DELETE');
  });

  test('delete throws ApiError carrying status and message', async () => {
    stub(404, { error: 'member not found' });
    const err = await api.delete('/members/missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toMatch(/member not found/);
  });
});

/**
 * The runs adapter (`runApi`). Two kinds of assertion live here: the URLs it
 * addresses, and the two normalization decisions the page cannot make for
 * itself — the jsonb columns arriving as `unknown`, and a cost of NULL meaning
 * "could not be priced" rather than zero (honesty rule 3).
 */
const capture = (status = 200, body: unknown = {}) => {
  const seen: { url: string; method: string } = { url: '', method: '' };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.url = url; seen.method = init?.method ?? 'GET';
    return new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return seen;
};

const serverRun = {
  runId: 'run-1', scheduleId: 'sch-1', scheduleName: 'nightly', state: 'succeeded', attempt: 1,
  slot: '2026-09-17T02:00', fireAt: '2026-09-17T06:00:00.000Z',
  startedAt: '2026-09-17T06:00:01.000Z', finishedAt: '2026-09-17T06:03:00.000Z',
  model: 'claude-opus-4-1-20250805', harnessVersion: '2.1.274', budgetUsd: '5.00',
  costUsd: null, failureClass: null, numTurns: 0, revertedAt: null, revertCommit: null,
};

const writeDiff = {
  sourceId: 'shared', before: 'aaaa', after: 'bbbb',
  commits: [{ sha: 'bbbb', author: 'Ada', email: 'ada@example.test', subject: 's', at: '2026-09-17T06:01:00.000Z' }],
  files: [{ status: 'A', path: 'reports/briefing.md' }],
  concurrentWriters: true, foreignCommitCount: 2, foreignAuthors: ['Grace <grace@example.test>'],
};

describe('the runs api client', () => {
  test('list and detail address their own resources', async () => {
    const l = capture(200, { runs: [] });
    await runApi.list();
    expect(l.url).toBe('/api/runs');

    const limited = capture(200, { runs: [] });
    await runApi.list(25);
    expect(limited.url).toBe('/api/runs?limit=25');

    const d = capture(200, { ...serverRun, prompt: 'p', events: [], usage: [], diff: null, heads: { before: {}, after: {} }, failureDetail: null, connectionId: null, clientName: null, tokenRevokedAt: null });
    await runApi.detail('run-1');
    expect(d.url).toBe('/api/runs/run-1');
  });

  test('the detail normalizes the jsonb columns the route can only send as `unknown`', async () => {
    capture(200, {
      ...serverRun,
      prompt: 'Summarize the week.',
      events: [{ seq: 1, at: '2026-09-17T06:00:02.000Z', kind: 'assistant', data: { type: 'assistant' } }],
      usage: [{ seq: 1, at: '2026-09-17T06:00:02.000Z', model: 'm', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: null, stopReason: null, httpStatus: 200 }],
      diff: { write: writeDiff, readSpaceMoves: [{ sourceId: 'customers', before: '1', after: '2' }], concurrentWriters: true },
      heads: { before: { shared: 'aaaa' }, after: { shared: 'bbbb' } },
      failureDetail: null, connectionId: null, clientName: null, tokenRevokedAt: null,
    });
    const detail = await runApi.detail('run-1');
    expect(detail.diff?.write.foreignCommitCount).toBe(2);
    expect(detail.diff?.readSpaceMoves).toEqual([{ sourceId: 'customers', before: '1', after: '2' }]);
    expect(detail.heads).toEqual({ before: { shared: 'aaaa' }, after: { shared: 'bbbb' } });
    expect(detail.prompt).toBe('Summarize the week.');
    // A NULL cost survives the adapter as NULL — it must never become 0.
    expect(detail.costUsd).toBeNull();
    expect(detail.usage[0]!.costUsd).toBeNull();
  });

  test('a diff summary missing its range reads as NO diff, not as a partial one', () => {
    // The page's hedge divides foreign commits by the range length; a half-read
    // summary would render "NaN of NaN". Absence is nameable, a partial is not.
    expect(toDiffSummary({ write: { sourceId: 'shared' } })).toBeNull();
    expect(toDiffSummary(null)).toBeNull();
    expect(toDiffSummary('nonsense')).toBeNull();
    expect(toDiffSummary({ readSpaceMoves: [] })).toBeNull();
  });

  test('heads drop anything that is not a source -> sha string pair', () => {
    expect(toSpaceHeads({ shared: 'aaaa', broken: 7, also: null })).toEqual({ shared: 'aaaa' });
    expect(toSpaceHeads(null)).toEqual({});
    expect(toSpaceHeads(['shared'])).toEqual({});
  });

  test('revert posts to the run and carries the confirmation as a query param', async () => {
    const plain = capture(200, { reverted: true });
    await runApi.revert('run-1');
    expect(plain.url).toBe('/api/runs/run-1/revert');
    expect(plain.method).toBe('POST');

    const confirmed = capture(200, { reverted: true });
    await runApi.revert('run-1', 'concurrent');
    expect(confirmed.url).toBe('/api/runs/run-1/revert?confirm=concurrent');
    expect(confirmed.method).toBe('POST');
  });

  test('a 409 refusal arrives as an ApiError whose body is the choice', async () => {
    capture(409, {
      error: 'revert_concurrent_writers', runId: 'run-1', sourceId: 'shared',
      commitCount: 5, foreignCommitCount: 2, foreignAuthors: ['Grace <grace@example.test>'],
    });
    const err = await runApi.revert('run-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).body.foreignCommitCount).toBe(2);
  });

  test('the runner state comes from /api/health, and a silent control plane is not `disabled`', async () => {
    const seen = capture(200, { ok: true, runner: { state: 'never_claimed', lastSeenAt: null, version: null } });
    const status = await runApi.runner();
    expect(seen.url).toBe('/api/health');
    expect(status.state).toBe('never_claimed');

    capture(200, { ok: true });
    expect((await runApi.runner()).state).toBe('unreported');
    // A version is never invented: the ledger does not record one.
    expect(toRunnerStatus({ state: 'connected' }).version).toBeNull();
  });
});
