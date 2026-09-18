import { test, expect } from 'bun:test';

const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8443';

test('C1: /metrics does not answer an unauthenticated public request', async () => {
  const res = await fetch(`${BASE}/metrics`, { tls: { rejectUnauthorized: false } });
  console.log(`MEASURED public /metrics: ${res.status}`);
  expect([401, 403, 404]).toContain(res.status);
});
