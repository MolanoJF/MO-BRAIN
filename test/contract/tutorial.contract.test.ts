import { test, expect, beforeAll, afterAll } from 'bun:test';
import { runTutorial } from '../../scripts/tutorial.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { composeUp, composeDown, resetBrain } from '../helpers/stack.ts';

beforeAll(async () => { await composeUp(); await resetBrain(); }, 300_000);
afterAll(async () => { await composeDown(); }, 120_000);

test('the whole company-brain tutorial runs unattended and ends doctor-green', async () => {
  const report = await runTutorial();

  const failed = report.steps.filter((s) => !s.ok);
  expect(failed.map((s) => `${s.id} (exit ${s.exitCode})`)).toEqual([]);

  // V6: doctor exits non-zero on blockers.
  expect(report.doctorExitCode).toBe(0);

  // The real isolation proof (see scripts/tutorial.ts's file header for why
  // this replaced the original local-admin `gbrain search` theatre): each
  // simulated teammate gets their own OAuth-backed thin-client GBRAIN_HOME,
  // and every `search` result they see must come from a source in THEIR
  // OWN federated-read grant, never gbrain-ops's local-admin view.
  expect(report.isolationOk).toBe(true);
}, 2_400_000);

// G4 registry-coverage precedent (Task 13's 'serve' shape-assertion, applied
// here to the three operations Task 12 added): these are ACTUALLY exercised
// live inside runTutorial() above (real OAuth handshakes, real MCP calls) —
// this second test just pins their argv shape so a future registry edit
// that silently changes flag names shows up as a diff here too.
test('init.mcpOnly, whoami and search are registered with the flags the isolation check depends on', () => {
  const mcpOnly = OPERATIONS['init.mcpOnly']!;
  expect(buildArgv(mcpOnly, {
    issuerUrl: 'http://127.0.0.1:3131', mcpUrl: 'http://127.0.0.1:3131/mcp',
    oauthClientId: 'id', oauthClientSecret: 'secret',
  })).toEqual([
    'init', '--mcp-only',
    '--issuer-url', 'http://127.0.0.1:3131',
    '--mcp-url', 'http://127.0.0.1:3131/mcp',
    '--oauth-client-id', 'id',
    '--oauth-client-secret', 'secret',
  ]);

  const whoami = OPERATIONS.whoami!;
  expect(buildArgv(whoami, {})).toEqual(['whoami']);

  const search = OPERATIONS.search!;
  expect(buildArgv(search, { query: 'performance review' })).toEqual(['search', 'performance review']);
});
