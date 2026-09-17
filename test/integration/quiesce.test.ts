import { test, expect, describe } from 'bun:test';
import { existsSync } from 'node:fs';
import { QUIESCE_ORDER, quiesce, resume } from '../../src/upgrade/quiesce.ts';
import type { UpgradeContext } from '../../src/upgrade/types.ts';

const COMPOSE = [
  'docker', 'compose',
  ...(existsSync('.env') ? ['--env-file', '.env'] as const : []),
  '-f', 'compose/docker-compose.yml',
];
const SKIP_QUIESCE_INTEGRATION_ENV = 'BRAINSTAND_ALLOW_SKIP_QUIESCE_INTEGRATION';

/** Same shape as test/integration/backup.test.ts's probeBackupStack —
 *  quiesce needs the real stack up, not merely the Docker CLI present. */
async function probeStack(): Promise<boolean> {
  const p = Bun.spawn(
    [...COMPOSE, 'ps', '--status', 'running', '-q', 'postgres', 'gbrain-ops', 'scheduler'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const timer = setTimeout(() => p.kill(), 5_000);
  try {
    const [stdout, exitCode] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (exitCode !== 0) return false;
    return stdout.trim().split(/\s+/).filter(Boolean).length >= 3;
  } catch { return false; } finally { clearTimeout(timer); }
}
const stackAvailable = await probeStack();

async function runningServices(): Promise<string[]> {
  const p = Bun.spawn([...COMPOSE, 'ps', '--services', '--filter', 'status=running'],
    { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(p.stdout).text();
  await p.exited;
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

describe('quiesce: real stack', () => {
  test('quiesce integration tests are not silently skipped', () => {
    if (stackAvailable) return;
    if (process.env[SKIP_QUIESCE_INTEGRATION_ENV] === '1') return;
    throw new Error(
      'The full compose stack is not up, so the real quiesce/resume round trip was skipped. Bring ' +
      'it up with docker compose --env-file .env -f compose/docker-compose.yml up -d --wait, or set ' +
      `${SKIP_QUIESCE_INTEGRATION_ENV}=1 to acknowledge skipping it for this run.`,
    );
  });

  test.skipIf(!stackAvailable)(
    'stops every service but postgres, in QUIESCE_ORDER, and resume brings them all back',
    async () => {
      const ctx = {
        runId: 'quiesce-it', fromVersion: process.env.GBRAIN_VERSION ?? '0.50.0.0',
        toVersion: process.env.GBRAIN_VERSION ?? '0.50.0.0', dryRun: false,
        upgradeDir: '/tmp/quiesce-it', envPath: '.env', compose: COMPOSE,
        journal: null, now: () => new Date(),
      } as unknown as UpgradeContext;

      try {
        const evidence = await quiesce(ctx);
        expect(evidence.stopped).toEqual([...QUIESCE_ORDER]);

        // Plan defect corrected (evidence: `docker compose ps` shows `caddy`
        // Up, and caddy is not in QUIESCE_ORDER). The plan's literal
        // `toEqual(['postgres'])` omits the stateless ingress QUIESCE_ORDER
        // deliberately never stops (D3 stops writers only), so it cannot hold
        // on a stock stack. Assert the load-bearing claim directly instead:
        // every writer is down, postgres is up, and nothing beyond postgres +
        // caddy is left running. This is not weaker than `['postgres']` — it
        // still fails if any QUIESCE_ORDER service survives or an unexpected
        // service appears.
        const afterQuiesce = await runningServices();
        expect(afterQuiesce).toContain('postgres');
        for (const svc of QUIESCE_ORDER) expect(afterQuiesce).not.toContain(svc);
        expect(afterQuiesce.filter((s) => s !== 'postgres' && s !== 'caddy')).toEqual([]);
      } finally {
        // The task requires the live stack be left healthy even when an
        // assertion (or a mid-quiesce stop) fails, so restore unconditionally.
        // The plan sample only resumed on the success path.
        await resume(ctx);
      }

      const backUp = await runningServices();
      for (const svc of QUIESCE_ORDER) expect(backUp).toContain(svc);
    },
    600_000,
  );
});
