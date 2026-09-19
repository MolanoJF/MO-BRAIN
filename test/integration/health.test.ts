import { test, expect, describe } from 'bun:test';

// This suite exercises the control app IN-PROCESS with no ops sidecar: pin
// verification must not fabricate a match against a container it never
// reached. State that precondition explicitly instead of depending on a
// sibling file's quiesce timing — `opsClient` binds OPS_RPC_URL at MODULE
// LOAD, hence the dynamic import below.
process.env.OPS_RPC_URL = 'http://127.0.0.1:1';
const { default: app } = await import('../../src/control/app.ts');
const { GBRAIN_PIN } = await import('../../src/contracts/pin.ts');

describe('/api/health', () => {
  // /health and /metrics belong to gbrain-serve — live collisions. The
  // console's health endpoint is /api/health.
  test('the console does NOT serve /health', async () => {
    expect((await app.request('/health')).status).toBe(404);
  });

  test('the console does NOT serve /metrics', async () => {
    expect((await app.request('/metrics')).status).toBe(404);
  });

  test('/api/health reports component status', async () => {
    const res = await app.request('/api/health');
    // 503 is the correct status when a component is down (ops is down
    // without a sidecar). 5xx crashes are the thing this must not be.
    expect([200, 503]).toContain(res.status);
    const body = await res.json() as {
      ok: unknown;
      components: { controlDb?: unknown; ops?: unknown };
      gbrainVersion: unknown;
      repos: unknown;
    };
    expect(body).toHaveProperty('ok');
    expect(body.components).toHaveProperty('controlDb');
    expect(body.components).toHaveProperty('ops');
    expect(body).toHaveProperty('gbrainVersion');
    expect(Array.isArray(body.repos)).toBe(true);
  });

  test('/api/health never leaks a connection string', async () => {
    const text = await (await app.request('/api/health')).text();
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
  });

  test('/api/health reports pin verification honestly, never a false match', async () => {
    const res = await app.request('/api/health');
    const body = await res.json() as { pin?: { declared?: unknown; matches?: unknown } };
    expect(body.pin).toBeDefined();
    expect(body.pin!.declared).toBe(GBRAIN_PIN);
    // ops is down in this suite (no sidecar) — pin verification must not
    // fabricate a match against a container it never reached.
    expect(body.pin!.matches === null || body.pin!.matches === false).toBe(true);
  });
});
