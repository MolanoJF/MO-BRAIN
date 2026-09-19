/**
 * Gate B for D8 (G4): `get_usage` against the pinned version.
 *
 * The main dev stack is the only world this file touches. The tool-surface leg
 * shells the running `gbrain-ops` container; `readBrainUsage` mints a
 * short-TTL `operator` client through the published ops RPC and calls the
 * published `get_usage` operation over the HTTP MCP lane; `listClients` counts
 * the same brain's OAuth clients through `auth clients --json`.
 *
 * `src/control/opsClient.ts` now resolves `OPS_RPC_URL` at CALL time, and
 * `readBrainUsage` resolves its MCP endpoint from `GBRAIN_MCP_URL` on first
 * call. The prelude below runs before the dynamic imports and supplies both
 * host-facing dev values (the dev override publishes ops on :3140 and Caddy on
 * :8443; Caddy's local CA is self-signed, hence the scoped TLS opt-out that
 * production's plain-http internal hop never needs). Call-time resolution is
 * what makes this file safe in the shared `bun test test/contract` process:
 * `scripts/connection-e2e.ts` briefly points `OPS_RPC_URL` at an unreachable
 * `:1` and restores it, rather than deciding this file's endpoint for it.
 */
import { expect, test, describe } from 'bun:test';

process.env.OPS_RPC_URL ??= 'http://127.0.0.1:3140';
process.env.GBRAIN_MCP_URL ??= 'https://localhost:8443/mcp';
process.env.GBRAIN_MCP_TLS_INSECURE ??= '1';

const { readBrainUsage } = await import('../../src/ops/usage.ts');
const { callOps } = await import('../../src/control/opsClient.ts');

const OPS_CONTAINER = `${process.env.COMPOSE_PROJECT_NAME ?? 'brainstand'}-gbrain-ops-1`;

/**
 * The real "list gbrain OAuth clients" reach the Slice 2/4 contract tests use
 * (`auth clients --json`), here over the MAIN stack's ops RPC so it counts the
 * very brain `readBrainUsage` mints into. The receipt is an OBJECT
 * (`{ window_days, usage_included, clients, legacy_tokens }`), never a bare
 * array — unwrap `.clients` rather than trusting a falsy default.
 */
async function listClients(): Promise<unknown[]> {
  const r = await callOps<{ clients?: unknown[] }>('auth.clients', {}, { json: true });
  const clients = r.json?.clients;
  if (!Array.isArray(clients)) throw new Error('auth clients --json did not include a clients array');
  return clients;
}

describe('get_usage at the pinned version (D8, G4)', () => {
  test('the operation exists in the pinned binary’s published tool surface', () => {
    const r = Bun.spawnSync(['docker', 'exec', OPS_CONTAINER, 'gbrain', '--tools-json']);
    const tools = JSON.parse(r.stdout.toString()) as { name: string }[];
    const names = tools.map((t) => t.name);
    console.log(`MEASURED tool surface at ${process.env.GBRAIN_VERSION}: ${names.length} tools, get_usage present=${names.includes('get_usage')}`);
    expect(names).toContain('get_usage');
  });

  test('it answers with totals AND a coverage block', async () => {
    const usage = await readBrainUsage(30);
    console.log(`MEASURED get_usage(30): calls=${usage.totals.calls} cost=$${usage.totals.costUsd} ` +
                `models=${usage.byModel.length} phases=${usage.byPhase.length} ` +
                `coverage.loggedSince=${usage.coverage.loggedSince} tablePresent=${usage.coverage.tablePresent}`);
    expect(usage.windowDays).toBe(30);
    expect(typeof usage.totals.calls).toBe('number');
    expect(usage.coverage.source).toBe('gateway.chat');
    // The four exclusions upstream names. If this array shrinks, our page lies.
    expect(usage.coverage.notCovered.length).toBeGreaterThanOrEqual(4);
    expect(usage.coverage.notCovered.join(' ')).toMatch(/embeddings/i);
  });

  test('an unpriced call is counted, never priced at zero (honesty rule 3)', async () => {
    const usage = await readBrainUsage(365);
    for (const m of usage.byModel) {
      if (m.unpricedCalls > 0 && m.costUsd !== null) {
        // Legal: some calls priced, some not. What is illegal is claiming a
        // total is complete when unpricedCalls > 0 — the page must say so.
        expect(usage.coverage.unpricedCalls).toBeGreaterThan(0);
      }
    }
    console.log(`MEASURED get_usage(365): calls=${usage.totals.calls} ` +
                `unpricedCalls=${usage.coverage.unpricedCalls} models=${usage.byModel.length}`);
  });

  test('the admin client minted for the call is revoked afterwards', async () => {
    const before = await listClients();
    await readBrainUsage(1);
    const after = await listClients();
    console.log(`MEASURED clients before=${before.length} after=${after.length}`);
    expect(after.length).toBe(before.length);
  });
});
