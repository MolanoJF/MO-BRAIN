import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, type Cli } from './harness.ts';

let c: Cli;
beforeEach(async () => { c = await cliWorld(); await c.runnerEnv(); });
afterEach(async () => rm(c.root, { recursive: true, force: true }));

test('systemd user timers when the user bus works and lingering is on', async () => {
  await c.stub('systemctl');
  await c.stub('loginctl', 'echo yes');
  const r = await c.run(['timers', 'install']);
  expect(r.stdout).toContain('systemd');
  const unit = await readFile(join(c.home, '.config/systemd/user/mobrain-collect.service'), 'utf8');
  expect(unit).toMatch(/ExecStart=.*bin\/mobrain collect --due/);
  expect(unit).toContain('Environment=PATH=');
  expect(unit).toContain('.local/bin');
  expect(await readFile(join(c.home, '.config/systemd/user/mobrain-collect.timer'), 'utf8')).toContain('OnCalendar=*:0/15');
  expect((await c.calls('systemctl')).map((a) => a.join(' '))).toContain('--user enable --now mobrain-collect.timer');
});

test('crontab fallback replaces only mobrain lines', async () => {
  await c.stub('systemctl', 'exit 1');
  await c.stub('loginctl', 'echo no');
  await c.stub('crontab', `if [ "$1" = -l ]; then printf '0 1 * * * other-job\\n*/15 * * * * old # mobrain\\n'; else cat > "$STUB_LOG.cron"; fi`);
  const r = await c.run(['timers', 'install']);
  expect(r.stdout).toContain('crontab');
  const cron = await readFile(`${c.env.STUB_LOG}.cron`, 'utf8');
  expect(cron).toContain('0 1 * * * other-job');
  expect(cron).not.toContain('old # mobrain');
  expect(cron).toMatch(/\*\/15 \* \* \* \* .*collect --due .* # mobrain/);
});
