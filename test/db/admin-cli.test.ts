// test/db/admin-cli.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { runAdminCli } from '../../src/server/admin-cli.ts';

let w: TestWorld;
beforeAll(async () => { w = await world(); });
afterAll(async () => w.drop());

test('bootstrap prints userId, password and apiKey as JSON', async () => {
  const out = await runAdminCli(['bootstrap', '--email', 'own@x.io', '--name', 'Own'], w.deps);
  const j = JSON.parse(out);
  expect(Object.keys(j).sort()).toEqual(['apiKey', 'password', 'userId']);
});

test('reset-password prints a new password that logs in', async () => {
  const j = JSON.parse(await runAdminCli(['reset-password', '--email', 'own@x.io'], w.deps));
  const r = await w.req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'own@x.io', password: j.password }) });
  expect(r.status).toBe(200);
});

test('unknown command is an error', async () => {
  await expect(runAdminCli(['nope'], w.deps)).rejects.toThrow(/usage/);
});
