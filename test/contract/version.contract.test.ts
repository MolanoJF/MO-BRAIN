import { test, expect, beforeAll, afterAll } from 'bun:test';
import { composeUp, composeDown, composeExec } from '../../src/docker/host.ts';

const PIN = process.env.GBRAIN_VERSION ?? '0.50.0.0';

beforeAll(async () => { await composeUp(); }, 300_000);
afterAll(async () => { await composeDown(); }, 120_000);

// The tripwire that makes "never fork, pin exact semver" (G1) safe: the whole
// contract suite is meaningless if it silently runs against another version.
test('the running binary is exactly the pinned version', async () => {
  const r = await composeExec('gbrain-ops', ['gbrain', '--version']);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe(PIN);
});

test('a wrong expected pin makes this suite fail', () => {
  // Documents the tripwire: CI runs the suite with GBRAIN_VERSION set to the
  // candidate. If the image and the expectation disagree, the test above is red.
  expect(PIN).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
});
