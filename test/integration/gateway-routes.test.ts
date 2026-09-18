/**
 * The gateway end to end, against real Postgres and a fake upstream.
 *
 * Every guard D7 names is asserted here as behaviour, not as wiring: the cap refuses **before** an
 * upstream connection exists (C9), the mid-stream cap closes a connection that was already open, an
 * unpriced model leaves `cost_usd` NULL and no call, the token dies with the run, and the log line
 * carries no content (S3c).
 *
 * L2: `CONTROL_DATABASE_URL` is defaulted in this file's own header, never required as an export.
 */
import {
  test, expect, describe, beforeAll, afterAll, beforeEach, afterEach, spyOn, type Mock,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.CONTROL_DATABASE_URL ??= 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

const { createGatewayRoutes } = await import('../../src/control/routes/gateway.ts');
const { mintGatewayToken } = await import('../../src/gateway/token.ts');
const { accruedCost, recordUsage } = await import('../../src/gateway/meter.ts');
const { priceUsage } = await import('../../src/gateway/pricing.ts');
const { storeSecret } = await import('../../src/control/secrets.ts');
const { getDb, schema, runMigrations, closeDb, pinDb } = await import('../../src/control/db/client.ts');

pinDb();

/** S3c: the marker is in the request body; it must never appear in a log line. */
const MARKER = 'PROMPT-MARKER-NEVER-LOGGED-7f3a9c';
const API_KEY = 'sk-ant-api03-not-a-real-secret';
const OAUTH_TOKEN = 'sk-ant-oat01-not-a-real-oauth-token-'.padEnd(108, 'x');
const HAIKU = 'claude-haiku-4-5';
const DATED_HAIKU = 'claude-haiku-4-5-20251001';

const encoder = new TextEncoder();
const frame = (event: string, payload: unknown) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

/** P2-a's usage, verbatim from the findings doc. */
const P2A_USAGE = {
  input_tokens: 10,
  cache_creation_input_tokens: 6922,
  cache_read_input_tokens: 13607,
  output_tokens: 54,
  cache_creation: { ephemeral_1h_input_tokens: 6922, ephemeral_5m_input_tokens: 0 },
};
const P2A_COST = 0.0154847;

const HAPPY_FRAMES = [
  frame('message_start', {
    type: 'message_start',
    message: { id: 'msg_1', model: DATED_HAIKU, usage: { ...P2A_USAGE, output_tokens: 1 } },
  }),
  frame('content_block_delta', {
    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'recorder-ok' },
  }),
  frame('message_delta', {
    type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 54 },
  }),
  frame('message_stop', { type: 'message_stop' }),
];

type UpstreamCall = { path: string; headers: Record<string, string>; body: string };

let upstream: {
  calls: UpstreamCall[];
  aborts: number;
  frames: string[];
  extraFrames: string[];
  json: unknown;
  server: Bun.Server<undefined>;
};

function resetUpstream(): void {
  upstream.calls = [];
  upstream.aborts = 0;
  upstream.frames = HAPPY_FRAMES;
  upstream.extraFrames = [];
  upstream.json = null;
}

describe('POST /api/gateway/v1/messages', () => {
  let app: Hono;
  let orgId = '';
  let otherOrgId = '';
  let logs: Array<Record<string, unknown>> = [];
  let consoleSpy: Mock<typeof console.log>;

  async function makeRun(options: {
    budgetUsd?: string;
    model?: string;
    state?: string;
    tokenRevokedAt?: Date | null;
    organizationId?: string;
  } = {}): Promise<{ runId: string; scheduleId: string; token: string }> {
    const scheduleId = randomUUID();
    const runId = randomUUID();
    const budgetUsd = options.budgetUsd ?? '0.5000000';
    const runOrgId = options.organizationId ?? orgId;
    await getDb().insert(schema.schedules).values({
      id: scheduleId,
      organizationId: runOrgId,
      name: `gw-${scheduleId.slice(0, 8)}`,
      kind: 'interval',
      intervalSeconds: 3600,
      anchorAt: new Date(),
      jobType: 'agent_prompt',
      operation: null,
      agentPrompt: 'do the thing',
      agentModel: options.model ?? HAIKU,
      agentMaxTokens: 256,
      agentBudgetUsd: budgetUsd,
      agentHarnessVersion: '2.1.274',
      createdBy: 'gateway-test',
    });
    await getDb().insert(schema.scheduleRuns).values({
      id: runId,
      scheduleId,
      organizationId: runOrgId,
      slot: `2026-09-17T00:00:00Z#${scheduleId.slice(0, 8)}`,
      fireAt: new Date(),
      state: options.state ?? 'running',
    });
    await getDb().insert(schema.agentRuns).values({
      runId,
      organizationId: runOrgId,
      model: options.model ?? HAIKU,
      harnessVersion: '2.1.274',
      budgetUsd,
      tokenRevokedAt: options.tokenRevokedAt ?? null,
    });
    return { runId, scheduleId, token: mintGatewayToken(runId, 600) };
  }

  function post(token: string, body: Record<string, unknown>, query = '?beta=true') {
    return app.request(`/api/gateway/v1/messages${query}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
        'user-agent': 'claude-cli/2.1.274 (external, sdk-cli)',
        'x-app': 'cli',
      },
      body: JSON.stringify(body),
    });
  }

  /** The body the harness sends: the marker is brain content we must never log. */
  const messagesBody = (model: string, extra: Record<string, unknown> = {}) => ({
    model,
    max_tokens: 64,
    stream: true,
    system: MARKER,
    messages: [{ role: 'user', content: [{ type: 'text', text: MARKER }] }],
    ...extra,
  });

  beforeAll(async () => {
    upstream = {
      calls: [], aborts: 0, frames: HAPPY_FRAMES, extraFrames: [], json: null,
      server: Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          const headers: Record<string, string> = {};
          req.headers.forEach((value, name) => { headers[name] = value; });
          upstream.calls.push({ path: `${url.pathname}${url.search}`, headers, body: await req.text() });
          // Resolves on the client's disconnect, so the frames below need no guessed duration; the
          // safety race exists only so a never-aborted connection cannot hang the suite.
          const disconnected = new Promise<void>((resolve) => {
            req.signal.addEventListener('abort', () => { upstream.aborts += 1; resolve(); });
          });
          if (upstream.json !== null) {
            return new Response(JSON.stringify(upstream.json), {
              headers: { 'content-type': 'application/json' },
            });
          }
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              for (const chunk of upstream.frames) controller.enqueue(encoder.encode(chunk));
              if (upstream.extraFrames.length > 0) {
                await Promise.race([disconnected, Bun.sleep(2000)]);
              }
              for (const chunk of upstream.extraFrames) {
                try {
                  controller.enqueue(encoder.encode(chunk));
                } catch { /* the client is gone: that is the assertion */ }
              }
              try {
                controller.close();
              } catch { /* already closed by the disconnect */ }
            },
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        },
      }),
    };

    await runMigrations();
    orgId = randomUUID();
    otherOrgId = randomUUID();
    await getDb().insert(schema.organizations).values([
      { id: orgId, name: 'Gateway Test', slug: `gateway-test-${orgId.slice(0, 8)}` },
      { id: otherOrgId, name: 'Gateway Test No Secret', slug: `gateway-nosecret-${otherOrgId.slice(0, 8)}` },
    ]);
    await storeSecret(orgId, 'anthropic_api_key', API_KEY);

    app = new Hono();
    app.route('/api/gateway', createGatewayRoutes({
      upstreamBaseUrl: `http://127.0.0.1:${upstream.server.port}`,
      log: (line) => { logs.push(line as unknown as Record<string, unknown>); },
    }));
  }, 60_000);

  beforeEach(() => {
    resetUpstream();
    logs = [];
    consoleSpy = spyOn(console, 'log');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  afterAll(async () => {
    await getDb().delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await getDb().delete(schema.organizations).where(eq(schema.organizations.id, otherOrgId));
    upstream.server.stop(true);
    await closeDb();
  });

  // --- F4: the pre-flight probe ---------------------------------------------------------------

  test('HEAD /api/gateway/api/hello is answered, not 404 — a 404 here aborts every run', async () => {
    const res = await app.request('/api/gateway/api/hello', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(0);
  });

  // --- leg one: the gateway token -------------------------------------------------------------

  test('no token, a junk token and a foreign signature are all 401 with no upstream call', async () => {
    const { runId } = await makeRun();
    for (const token of ['', 'not-a-token', `${runId}.9999999999.deadbeef`]) {
      const res = await post(token, messagesBody(HAIKU));
      expect(res.status).toBe(401);
      expect((await res.json() as { error: { type: string } }).error.type).toBe('authentication_error');
    }
    expect(upstream.calls).toHaveLength(0);
  });

  test('a token whose run was revoked is refused — the token dies with the run (honesty rule 9)', async () => {
    const { token } = await makeRun({ tokenRevokedAt: new Date() });
    const res = await post(token, messagesBody(HAIKU));
    expect(res.status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
  });

  test('a token for a run in a terminal state is refused', async () => {
    const { token } = await makeRun({ state: 'succeeded' });
    expect((await post(token, messagesBody(HAIKU))).status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
  });

  test('a token for a run that does not exist is refused', async () => {
    const token = mintGatewayToken(randomUUID(), 600);
    expect((await post(token, messagesBody(HAIKU))).status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
  });

  // --- the happy path ------------------------------------------------------------------------

  test('a real call streams through byte-identical, and the meter writes the usage row', async () => {
    const { runId, token } = await makeRun();
    const res = await post(token, messagesBody(HAIKU));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    // The response the harness receives is the upstream's stream, byte for byte.
    expect(await res.text()).toBe(HAPPY_FRAMES.join(''));

    // Leg two: the org's secret went out as x-api-key, and the harness's own headers were forwarded.
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.path).toBe('/v1/messages?beta=true');
    expect(call.headers['x-api-key']).toBe(API_KEY);
    expect(call.headers.authorization).toBeUndefined();
    expect(call.headers['user-agent']).toBe('claude-cli/2.1.274 (external, sdk-cli)');
    expect(call.headers['anthropic-beta']).toBe('fine-grained-tool-streaming-2025-05-14');
    expect(call.body).toContain(MARKER);

    // The meter's own numbers, not `total_cost_usd` (F9): the response's dated model id, the exact
    // counts, and a cost that equals `priceUsage` over them.
    const [usage] = await getDb().select().from(schema.agentRunUsage)
      .where(eq(schema.agentRunUsage.runId, runId));
    expect(usage!.model).toBe(DATED_HAIKU);
    expect(usage!.inputTokens).toBe(10);
    expect(usage!.outputTokens).toBe(54);
    expect(usage!.cacheReadTokens).toBe(13607);
    expect(usage!.cacheWriteTokens).toBe(6922);
    expect(usage!.stopReason).toBe('end_turn');
    expect(usage!.httpStatus).toBe(200);
    expect(Number(usage!.costUsd)).toBe(P2A_COST);
    expect(Number(usage!.costUsd)).toBe(priceUsage(DATED_HAIKU, P2A_USAGE)!);
    expect(Number(usage!.costUsd)).not.toBe(0);

    // The run rollup is the SUM of its usage rows, and the accrued total follows.
    const [run] = await getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.runId, runId));
    expect(run!.costUsd).toBe('0.0154847');
    expect(run!.inputTokens).toBe(10);
    expect(run!.outputTokens).toBe(54);
    expect(run!.cacheWriteTokens).toBe(6922);
    expect(await accruedCost(runId)).toBe(P2A_COST);

    // S3c: five keys, and nothing from the body.
    expect(logs).toEqual([{
      runId, model: DATED_HAIKU, status: 200, tokens: 10 + 54 + 13607 + 6922, costUsd: P2A_COST,
    }]);
  });

  test('an OAuth upstream credential goes out as Bearer plus the oauth beta, never as x-api-key', async () => {
    await storeSecret(orgId, 'anthropic_api_key', OAUTH_TOKEN);
    try {
      const { token } = await makeRun();
      const res = await post(token, messagesBody(HAIKU));
      expect(res.status).toBe(200);
      await res.text();
      const call = upstream.calls[0]!;
      expect(call.headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
      expect(call.headers['x-api-key']).toBeUndefined();
      expect(call.headers['anthropic-beta']).toContain('fine-grained-tool-streaming-2025-05-14');
      expect(call.headers['anthropic-beta']).toContain('oauth-2025-04-20');
    } finally {
      await storeSecret(orgId, 'anthropic_api_key', API_KEY);
    }
  });

  test('the run row carries the pinned model, and a dated id is priced from it', async () => {
    const { runId, token } = await makeRun({ model: HAIKU });
    const res = await post(token, messagesBody(DATED_HAIKU));
    expect(res.status).toBe(200);
    // The meter writes when the stream ends, so the client must have read it.
    await res.text();
    const [run] = await getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.runId, runId));
    expect(run!.model).toBe(HAIKU);
    expect(await accruedCost(runId)).toBe(P2A_COST);
  });

  test('an org with no stored credential is a loud 503, and no upstream call', async () => {
    const { token } = await makeRun({ organizationId: otherOrgId });
    const res = await post(token, messagesBody(HAIKU));
    expect(res.status).toBe(503);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('gateway_misconfigured');
    expect(upstream.calls).toHaveLength(0);
  });

  // --- the cap, before the connection exists (C9) ---------------------------------------------

  test('the cap refuses before forwarding, marks the run, alerts, and opens no connection', async () => {
    const { runId, scheduleId, token } = await makeRun({ budgetUsd: '0.0100000' });
    await recordUsage({
      runId, model: HAIKU, costUsd: 0.0102932, httpStatus: 200,
      counts: {
        inputTokens: 10, outputTokens: 54, cacheReadTokens: 13607,
        cacheWrite5mTokens: 6922, cacheWrite1hTokens: 0,
      },
    });

    const res = await post(token, messagesBody(HAIKU));
    expect(res.status).toBe(402);
    const body = await res.json() as { type: string; error: { type: string; code: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('budget_exceeded');
    expect(body.error.code).toBe('budget_exceeded');

    // Not one byte went upstream, and no second usage row exists.
    expect(upstream.calls).toHaveLength(0);
    const usage = await getDb().select().from(schema.agentRunUsage).where(eq(schema.agentRunUsage.runId, runId));
    expect(usage).toHaveLength(1);

    const [run] = await getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.runId, runId));
    expect(run!.failureClass).toBe('budget_exceeded');
    const [scheduleRun] = await getDb().select().from(schema.scheduleRuns).where(eq(schema.scheduleRuns.id, runId));
    expect(scheduleRun!.classification).toBe('budget_exceeded');
    const alerts = await getDb().select().from(schema.scheduleAlerts)
      .where(eq(schema.scheduleAlerts.runId, runId));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe('agent_budget_exceeded');
    expect(alerts[0]!.scheduleId).toBe(scheduleId);
    expect(alerts[0]!.detail).toMatchObject({ budgetUsd: 0.01, accruedUsd: 0.0102932 });
  });

  test('a cap spent exactly to the limit is refused: >= means stopped', async () => {
    const { runId, token } = await makeRun({ budgetUsd: '0.0154847' });
    await recordUsage({
      runId, model: HAIKU, costUsd: P2A_COST, httpStatus: 200,
      counts: {
        inputTokens: 10, outputTokens: 54, cacheReadTokens: 13607,
        cacheWrite5mTokens: 0, cacheWrite1hTokens: 6922,
      },
    });
    expect((await post(token, messagesBody(HAIKU))).status).toBe(402);
    expect(upstream.calls).toHaveLength(0);
  });

  test('a run with an unpriced call in it is budget-unknowable and refused', async () => {
    const { runId, token } = await makeRun({ budgetUsd: '1.0000000' });
    await recordUsage({
      runId, model: HAIKU, costUsd: null, httpStatus: 200,
      counts: {
        inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
      },
    });
    expect(await accruedCost(runId)).toBeNull();

    const res = await post(token, messagesBody(HAIKU));
    expect(res.status).toBe(402);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('budget_unknowable');
    expect(upstream.calls).toHaveLength(0);
  });

  // --- an unpriced model is a call we do not make (honesty rule 3) ------------------------------

  test('an unpriced model is refused with a NULL cost row — never a fake zero', async () => {
    const { runId, token } = await makeRun({ model: 'claude-nonesuch-9' });
    const res = await post(token, messagesBody('claude-nonesuch-9'));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('model_unpriced');
    expect(upstream.calls).toHaveLength(0);

    const [usage] = await getDb().select().from(schema.agentRunUsage)
      .where(eq(schema.agentRunUsage.runId, runId));
    expect(usage!.model).toBe('claude-nonesuch-9');
    expect(usage!.costUsd).toBeNull();
    expect(usage!.costUsd).not.toBe('0.0000000');
    expect(usage!.httpStatus).toBe(400);

    const [run] = await getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.runId, runId));
    expect(run!.failureClass).toBe('refused');
    expect(run!.failureDetail).toMatchObject({ reason: 'model_unpriced', model: 'claude-nonesuch-9' });
    expect(run!.costUsd).toBeNull();
    const alerts = await getDb().select().from(schema.scheduleAlerts)
      .where(eq(schema.scheduleAlerts.runId, runId));
    // The closed vocabulary (`src/agent/alerts.ts`): the precise reason is in the detail, the row is
    // what a retry policy reads, and the console already registers this kind.
    expect(alerts.map((a) => a.kind)).toEqual(['agent_run_failed']);
    expect(alerts[0]!.detail).toMatchObject({ reason: 'model_unpriced' });
  });

  // --- the mid-stream cap ---------------------------------------------------------------------

  test('the cap fires mid-stream: the upstream is closed, the run ends, the bound is recorded', async () => {
    // $0.00005 of headroom. The message_start's 10 input tokens ($0.00001) fit; the first text delta
    // cannot, and it arrives while the response is still open.
    const { runId, token } = await makeRun({ budgetUsd: '0.0000500' });
    upstream.frames = [
      frame('message_start', {
        type: 'message_start', message: { model: DATED_HAIKU, usage: { input_tokens: 10 } },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x'.repeat(200) },
      }),
    ];
    // What a real upstream would keep sending after the crossing — the client must never see it.
    upstream.extraFrames = [
      frame('message_delta', {
        type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5000 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ];

    const res = await post(token, messagesBody(HAIKU));
    expect(res.status).toBe(200); // the headers went out before the crossing
    const streamed = await res.text();

    // The terminal event replaces the rest of the response, and nothing follows it.
    expect(streamed).toContain('"type":"budget_exceeded"');
    expect(streamed).not.toContain('"output_tokens":5000');
    expect(streamed).not.toContain('message_stop');

    // The upstream connection was closed, not merely ignored.
    expect(upstream.aborts).toBe(1);

    const [run] = await getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.runId, runId));
    expect(run!.failureClass).toBe('budget_exceeded');
    const alerts = await getDb().select().from(schema.scheduleAlerts)
      .where(eq(schema.scheduleAlerts.runId, runId));
    expect(alerts.map((a) => a.kind)).toEqual(['agent_budget_exceeded']);

    // The row records the tokens actually metered, priced at the output byte bound — an upper bound,
    // never an undercount — and never `total_cost_usd`.
    const [usage] = await getDb().select().from(schema.agentRunUsage)
      .where(eq(schema.agentRunUsage.runId, runId));
    expect(usage!.model).toBe(DATED_HAIKU);
    expect(usage!.inputTokens).toBe(10);
    expect(usage!.outputTokens).toBeGreaterThanOrEqual(200);
    expect(Number(usage!.costUsd)).toBeGreaterThanOrEqual(0.00005);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ runId, status: 402 });
  });

  test('a stream that stays under the cap is passed through whole and not ended', async () => {
    const { runId, token } = await makeRun({ budgetUsd: '10.0000000' });
    const res = await post(token, messagesBody(HAIKU));
    expect(await res.text()).toBe(HAPPY_FRAMES.join(''));
    const [run] = await getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.runId, runId));
    expect(run!.failureClass).toBeNull();
    expect(upstream.aborts).toBe(0);
  });

  // --- the non-streaming fallback --------------------------------------------------------------

  test('a stream:false body is metered from the single JSON response', async () => {
    const { runId, token } = await makeRun();
    upstream.json = {
      id: 'msg_2',
      model: DATED_HAIKU,
      usage: P2A_USAGE,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'recorder-ok' }],
    };
    const text = JSON.stringify(upstream.json);
    const res = await post(token, messagesBody(HAIKU, { stream: false }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(text);

    const [usage] = await getDb().select().from(schema.agentRunUsage)
      .where(eq(schema.agentRunUsage.runId, runId));
    expect(usage!.outputTokens).toBe(54);
    expect(Number(usage!.costUsd)).toBe(P2A_COST);
  });

  // --- S3c ---------------------------------------------------------------------------------------

  test('no log line, from this file or the gateway, ever carries the request body', async () => {
    const { token } = await makeRun();
    const res = await post(token, messagesBody(HAIKU));
    expect(res.status).toBe(200);
    await res.text();

    const printed = consoleSpy.mock.calls.map((args) => JSON.stringify(args)).join('\n');
    expect(printed).not.toContain(MARKER);
    expect(printed).not.toContain(API_KEY);
    // And the gateway's own line is exactly the five fields D7 allows.
    expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0]!).sort()).toEqual(['costUsd', 'model', 'runId', 'status', 'tokens']);
  });
});
