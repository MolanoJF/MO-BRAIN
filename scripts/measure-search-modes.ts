#!/usr/bin/env bun
/**
 * Task 9 / D7 — measure the search-mode cost spread on THIS deployment.
 *
 * A probe that writes a constant, not a feature. For each mode the product
 * offers (`fast`, `balanced`, `thorough`) it sets the mode through the existing
 * `config.set` operation, reads the brain's own ledger as a baseline through
 * `readBrainUsage(1)`, runs the SAME fixed workload of 20 queries through the
 * `search` operation, reads the ledger again, and takes the delta. It prints a
 * `MEASURED` line per mode with the delta cost, the call count, the model mix
 * and the corpus size (`pages` / `chunks` from `sources.status`), and the total
 * real spend at the end. The original mode is restored in a `finally`.
 *
 * It is ALLOWED to produce nothing: a thin corpus, an empty `get_usage` ledger
 * or a mode the pinned binary refuses are honest nulls (D7), not failures to
 * paper over. Every mode that cannot be measured leaves `measuredCost: null`.
 *
 * `gbrain` is reached only through its published contracts: the ops RPC (an
 * argv allowlist — no shell strings here) and the `get_usage` operation over
 * the HTTP MCP data lane. Query text never reaches a shell.
 *
 * Host values mirror `test/contract/usage.contract.test.ts`: the dev override
 * publishes ops on :3140 and Caddy on :8443, and its local CA is self-signed.
 */
process.env.OPS_RPC_URL ??= 'http://127.0.0.1:3140';
process.env.GBRAIN_MCP_URL ??= 'https://localhost:8443/mcp';
process.env.GBRAIN_MCP_TLS_INSECURE ??= '1';

const { callOps } = await import('../src/control/opsClient.ts');
const { readBrainUsage } = await import('../src/ops/usage.ts');
import type { BrainUsage } from '../src/ops/usage.ts';

const MODES = ['fast', 'balanced', 'thorough'] as const;
type Mode = (typeof MODES)[number];

/** The workload is fixed before the run so the modes are comparable; changing
 *  it changes every ratio, and the disclaimer says so. */
const QUERIES = [
  'widget launch plan',
  'when does the widget ship',
  'customer onboarding',
  'Acme onboarding notes',
  'performance review process',
  'annual review cycle',
  'gate b seed',
  'gate c kill a',
  'widget',
  'launch',
  'onboarding',
  'customer notes',
  'internal performance review',
  'Q4 review cycle',
  'ship the widget',
  'faster onboarding',
  'Acme',
  'review process',
  'company wiki',
  'widget March',
] as const;

const LIMIT = '20';
const SEARCH_TIMEOUT_MS = 180_000;

export type CorpusSize = { spaces: number; pages: number; chunks: number };

export type ModeMeasurement = {
  mode: Mode;
  /** True when the pinned binary refused the value at `config.set` time. */
  invalidMode: boolean;
  deltaCostUsd: number;
  deltaCalls: number;
  models: { model: string; calls: number }[];
  queries: number;
  failures: number;
  corpus: CorpusSize;
};

function parseCorpus(json: unknown): CorpusSize {
  const sources = json && typeof json === 'object'
    ? (json as { sources?: unknown }).sources
    : undefined;
  if (!Array.isArray(sources)) return { spaces: 0, pages: 0, chunks: 0 };
  let pages = 0;
  let chunks = 0;
  for (const s of sources) {
    const row = s as { total_pages?: unknown; total_chunks?: unknown };
    if (typeof row.total_pages === 'number') pages += row.total_pages;
    if (typeof row.total_chunks === 'number') chunks += row.total_chunks;
  }
  return { spaces: sources.length, pages, chunks };
}

/** The ledger is cumulative over the window, so each model's contribution is
 *  the after-calls minus the before-calls; zero-delta models are dropped. */
function modelDelta(before: BrainUsage, after: BrainUsage): { model: string; calls: number }[] {
  const seen = new Map(before.byModel.map((m) => [m.model, m.calls]));
  return after.byModel
    .map((m) => ({ model: m.model, calls: m.calls - (seen.get(m.model) ?? 0) }))
    .filter((m) => m.calls > 0);
}

async function measureMode(mode: Mode, corpus: CorpusSize): Promise<ModeMeasurement> {
  const set = await callOps('config.set', { key: 'search.mode', value: mode });
  if (!set.ok) throw new Error(`config.set search.mode=${mode} failed (exit ${set.exitCode})`);
  const invalidMode = /Invalid search\.mode value/.test(set.stderr ?? '');

  const before = await readBrainUsage(1);
  let failures = 0;
  for (const query of QUERIES) {
    const r = await callOps('search', { query, limit: LIMIT }, { json: true, timeoutMs: SEARCH_TIMEOUT_MS });
    if (!r.ok) failures += 1;
  }
  const after = await readBrainUsage(1);

  const deltaCostUsd = after.totals.costUsd - before.totals.costUsd;
  const deltaCalls = after.totals.calls - before.totals.calls;
  const models = modelDelta(before, after);
  const mix = models.length === 0 ? 'none' : models.map((m) => `${m.model}:${m.calls}`).join(',');
  console.log(
    `MEASURED search-mode ${mode}: deltaCost=$${deltaCostUsd.toFixed(7)} ` +
    `calls=+${deltaCalls} models=[${mix}] queries=${QUERIES.length} failures=${failures} ` +
    `corpus=${corpus.spaces}spaces/${corpus.pages}pages/${corpus.chunks}chunks ` +
    `invalid=${invalidMode}`,
  );
  if (invalidMode) {
    console.error(
      `MEASURED search-mode ${mode}: the pinned binary refused this value — ` +
      `${set.stderr.trim().split('\n').join(' | ')}`,
    );
  }
  return { mode, invalidMode, deltaCostUsd, deltaCalls, models, queries: QUERIES.length, failures, corpus };
}

async function main(): Promise<void> {
  const original = (await callOps('config.get', { key: 'search.mode' })).stdout.trim();
  console.log(`MEASURED search-mode original=${JSON.stringify(original)}`);

  const status = await callOps('sources.status', {}, { json: true, timeoutMs: 120_000 });
  if (!status.ok) throw new Error(`sources.status failed (exit ${status.exitCode})`);
  const corpus = parseCorpus(status.json);

  const results: ModeMeasurement[] = [];
  let totalSpendUsd = 0;
  try {
    for (const mode of MODES) {
      const measured = await measureMode(mode, corpus);
      results.push(measured);
      totalSpendUsd += measured.deltaCostUsd;
    }
  } finally {
    const restore = await callOps('config.set', { key: 'search.mode', value: original });
    console.log(
      `MEASURED search-mode restored=${JSON.stringify(original)} ok=${restore.ok}`,
    );
  }

  console.log(
    `MEASURED search-mode total real spend across ${results.length} modes: ` +
    `$${totalSpendUsd.toFixed(7)} (get_usage ledger, window=1 day)`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error('BLOCKED:', err instanceof Error ? err.message : err);
    process.exit(2);
  }
}
