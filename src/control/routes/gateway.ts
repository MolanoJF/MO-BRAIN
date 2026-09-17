/**
 * `POST /api/gateway/v1/messages` — the model gateway the runner's harness talks to (D7).
 *
 * Task 6 mounts this router; the mount and nothing else is the contract:
 *
 *     app.route('/api/gateway', gatewayRoutes)
 *
 * The runner then sets `ANTHROPIC_BASE_URL=http://control-plane:3150/api/gateway`, so the harness's
 * own paths land where they must: `POST {base}/v1/messages?beta=true` (the model call) and
 * `HEAD {base}/api/hello` (F4, issued before the first call — a 404 there would abort every run for a
 * reason that has nothing to do with the meter).
 *
 * Two credentials on two legs, never conflated (F5):
 *   * leg one, runner → here: `Authorization: Bearer <per-run gateway token>`, verified statelessly;
 *   * leg two, here → upstream: the org's `anthropic_api_key`, resolved inside `proxyMessages` and
 *     never returned, logged, or handed to the caller.
 *
 * S3c: this file reads the request body because it must forward it. It never logs it — not the body,
 * not a header, not the message text of a parse failure (which is why parsing goes through
 * `safeJson`, whose failure carries no payload).
 */
import { Hono } from 'hono';
import { GatewayRefusal } from '../../gateway/meter.ts';
import { logGatewayLine, proxyMessages, refusalResponse, type GatewayDeps } from '../../gateway/proxy.ts';
import { verifyGatewayToken } from '../../gateway/token.ts';

/**
 * The router Task 6 mounts. The factory exists so a test can point the upstream leg at a local fake
 * and capture the log line; production takes this default instance, where the upstream is
 * `GATEWAY_UPSTREAM_URL` (absent in the stack: `https://api.anthropic.com`).
 */
export const gatewayRoutes = createGatewayRoutes();

export function createGatewayRoutes(deps: GatewayDeps = {}): Hono {
  const router = new Hono();

  /**
   * F4: the harness probes the base URL with `HEAD {base}/api/hello` before its first model call. It
   * needs no body and no shape — only that it is not an error, and Hono answers a HEAD from a GET
   * route. A 404 here is a run that dies for a reason that has nothing to do with the meter.
   */
  const hello = () => new Response(null, { status: 200 });
  router.get('/api/hello', hello);
  router.get('/hello', hello);

  /** `Authorization: Bearer <token>` (F5). `x-api-key` is accepted as the same lane's spare header. */
  function presentedToken(c: { req: { header: (n: string) => string | undefined } }): string | null {
    const authorization = c.req.header('authorization');
    if (authorization) {
      const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
      if (match?.[1]) return match[1];
    }
    return c.req.header('x-api-key') ?? null;
  }

  router.post('/v1/messages', async (c) => {
    const token = presentedToken(c);
    const verified = token ? verifyGatewayToken(token) : null;
    if (!verified) {
      // An expired signature and a forged one are the same answer: this token buys nothing.
      return c.json(
        errorBody('authentication_error', 'a valid per-run gateway token is required', 'invalid_gateway_token'),
        401,
      );
    }

    const raw = await c.req.text();
    const parsed = safeJson(raw) as { model?: unknown; stream?: unknown } | null;
    const model = typeof parsed?.model === 'string' ? parsed.model : '';
    if (!model) {
      return c.json(errorBody('invalid_request_error', 'model is required', 'model_required'), 400);
    }

    try {
      return await proxyMessages({
        runId: verified.runId,
        body: raw,
        model,
        query: new URL(c.req.url).search,
        clientHeaders: c.req.raw.headers,
        stream: parsed?.stream !== false,
      }, deps);
    } catch (e) {
      if (e instanceof GatewayRefusal) return refusalResponse(e);
      // Never the message: an unexpected error can quote what it was parsing (S3c).
      logGatewayLine({
        runId: verified.runId, model, status: 500, tokens: 0, costUsd: null,
      });
      console.error('[gateway] unhandled error', e instanceof Error ? e.name : typeof e);
      return c.json(errorBody('api_error', 'the gateway failed to proxy this call', 'gateway_error'), 500);
    }
  });

  return router;
}

function errorBody(type: string, message: string, code: string) {
  return { type: 'error', error: { type, message, code } };
}

function safeJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

