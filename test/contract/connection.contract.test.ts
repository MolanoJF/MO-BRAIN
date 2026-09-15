import { test, expect, beforeAll, afterAll } from 'bun:test';
import { runConnectionE2E } from '../../scripts/connection-e2e.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { compileConnection, clientName } from '../../src/contracts/compile.ts';
import { composeUp, composeDown } from '../helpers/stack.ts';

async function dockerComposeAvailable(): Promise<boolean> {
  try {
    const p = Bun.spawn(['docker', 'compose', 'version'], { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => p.kill(), 5_000);
    try {
      return (await p.exited) === 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

const dockerOk = await dockerComposeAvailable();

beforeAll(async () => {
  if (!dockerOk) {
    throw new Error(
      'docker compose is not usable; Gate A cannot hang on a down daemon. Start Docker and rerun bun test test/contract/connection.contract.test.ts',
    );
  }
  await composeUp();
}, 300_000);
afterAll(async () => {
  if (dockerOk) await composeDown();
}, 120_000);

test('Gate A: compiler pairing, scoped search, revoke, audit, doctor', async () => {
  const report = await runConnectionE2E();

  const failed = report.steps.filter((s) => !s.ok);
  expect(failed.map((s) => `${s.id} (exit ${s.exitCode})`)).toEqual([]);

  expect(report.pairingOk).toBe(true);
  expect(report.whoamiOk).toBe(true);
  expect(report.isolationOk).toBe(true);
  expect(report.revokeOk).toBe(true);
  expect(report.auditOk).toBe(true);
  expect(report.doctorExitCode).toBe(0);
}, 1_200_000);

test('compileConnection output is the mcp.grant flag set Gate A feeds', () => {
  const compiled = compileConnection(
    { role: 'member' },
    { sourceId: 'customers', slug: 'customers' },
    [{ sourceId: 'customers' }, { sourceId: 'shared' }, { sourceId: 'internal' }],
  );
  expect(compiled.profile).toBe('memory-writer');
  expect(compiled.sourceId).toBe('customers');
  expect(compiled.federatedRead).toEqual(['internal', 'shared']);
  expect(compiled.tokenTtl).toBe(3600);

  const name = clientName('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'customers');
  expect(buildArgv(OPERATIONS['mcp.grant']!, {
    name,
    harness: 'generic',
    profile: compiled.profile,
    source: compiled.sourceId,
    federatedRead: [...compiled.federatedRead],
    url: 'http://127.0.0.1:3131/mcp',
    tokenTtl: String(compiled.tokenTtl),
  }, { json: true, dryRun: true })).toEqual([
    'mcp', 'grant', name,
    '--harness', 'generic',
    '--profile', 'memory-writer',
    '--source', 'customers',
    '--federated-read', 'internal,shared',
    '--token-ttl', '3600',
    '--url', 'http://127.0.0.1:3131/mcp',
    '--dry-run', '--json',
  ]);
});
