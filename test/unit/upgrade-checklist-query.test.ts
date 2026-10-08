import { expect, test } from 'bun:test';

test('checklist state query is fed on stdin so psql interpolates the run id', async () => {
  const source = await Bun.file('scripts/upgrade.ts').text();
  const start = source.indexOf('async function checklistStates');
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf('async function applyDeclineOptOut'));
  expect(body).toContain('feedString');
  expect(body).not.toContain('-tAc');
  expect(body).toContain(":'run_id'");
  expect(body).not.toContain('run_id = \'${');
});
