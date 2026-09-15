import { test, expect, describe } from 'bun:test';
import app from '../../src/control/app.ts';

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
    };
    expect(body).toHaveProperty('ok');
    expect(body.components).toHaveProperty('controlDb');
    expect(body.components).toHaveProperty('ops');
    expect(body).toHaveProperty('gbrainVersion');
  });

  test('/api/health never leaks a connection string', async () => {
    const text = await (await app.request('/api/health')).text();
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
  });
});
