#!/usr/bin/env bun
/**
 * Open Q1 / risk 10 — 25-Space scale probe.
 *
 * Baseline: 1 Space holding a 25-page corpus. Scale: the same 25 pages
 * spread one-per-Space, searched through one Connection whose
 * federatedRead lists all 25. Thresholds are constants (C5) so the
 * result cannot be rationalized after the run.
 *
 * Not on CI. Slice0 stack only — never the production `brainstand-*`
 * compose project. Does not `compose down -v`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execOperation } from '../src/contracts/exec.ts';
import { OPERATIONS } from '../src/contracts/registry.ts';
import { composeExec, composeUp } from '../src/docker/host.ts';
import { BRAIN_DB_URL, resetBrain } from '../test/helpers/stack.ts';
import type { ParamValues } from '../src/contracts/types.ts';

// C5: the decision rule, fixed before the measurement so the result cannot be
// rationalized. Degradation past either threshold => STOP AND ESCALATE.
// Do NOT redesign Space boundaries inside Slice 2.
const P95_LATENCY_BUDGET = 3.0;   // × the 1-Space baseline
const RECALL_FLOOR        = 0.90; // × the 1-Space baseline's recall

const ROOT = resolve(import.meta.dir, '..');
const COMPOSE_FILE = 'compose/docker-compose.slice0.yml';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'openai:text-embedding-3-small';
const PAGE_COUNT = 25;
const QUERY_COUNT = 20;
const SEARCH_LIMIT = '10';
const MAX_SPEND_USD = 5;
const EMBED_USD_PER_MILLION = 0.02;

const MCP_BIND = '127.0.0.1';
const MCP_PORT = 3132;
const MCP_URL = `http://${MCP_BIND}:${MCP_PORT}/mcp`;
const ISSUER_URL = `http://${MCP_BIND}:${MCP_PORT}`;

const CLIENT_NAME = 'q1-scale-reader';
const MONO_SOURCE = 'q1-mono';

type Page = {
  n: number;
  id: string;
  file: string;
  token: string;
  title: string;
  body: string;
};

type QuerySpec = { id: string; query: string; token: string; title: string; sourceId: string };

type SearchSample = {
  query: string;
  token: string;
  sourceId: string;
  ms: number;
  hit: boolean;
  exitCode: number;
  hitCount: number;
};

type PhaseReport = {
  label: string;
  spaceCount: number;
  requestedFederatedRead: number;
  grantFederatedRead: number | null;
  whoamiFederatedRead: number | null;
  whoamiTransport: string | null;
  repoCount: number;
  sourcesListCount: number | null;
  sourcesStatusMs: number;
  embedMs: number;
  searchMs: number[];
  p95Ms: number;
  recall: number;
  hits: number;
  queries: number;
  samples: SearchSample[];
};

export type ScaleProbeReport = {
  thresholds: { P95_LATENCY_BUDGET: number; RECALL_FLOOR: number };
  embeddingModel: string;
  estimatedEmbedUsd: number;
  baseline: PhaseReport;
  scale: PhaseReport;
  latencyRatio: number;
  recallRatio: number;
  latencyPass: boolean;
  recallPass: boolean;
  pass: boolean;
};

const PAGES: Page[] = Array.from({ length: PAGE_COUNT }, (_, i) => {
  const n = i + 1;
  const id = `q1-s${String(n).padStart(2, '0')}`;
  const token = `ZXPROBE${String(n).padStart(2, '0')}QUOKKA`;
  const title = `Scale probe page ${String(n).padStart(2, '0')} ${token}`;
  return {
    n,
    id,
    file: `page-${String(n).padStart(2, '0')}.md`,
    token,
    title,
    body: `# ${title}\n\nThis page is uniquely identified by the token ${token}.\nIt is a short runbook about widget-${n} onboarding.\n`,
  };
});

const QUERIES: QuerySpec[] = PAGES.slice(0, QUERY_COUNT).map((p) => ({
  id: p.id,
  query: p.token,
  token: p.token,
  title: p.title,
  sourceId: p.id,
}));

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function findEnvFile(): string | null {
  const extras = [
    join(process.cwd(), '.env'),
    join(ROOT, '.env'),
    join('C:', 'Users', 'juanp', 'Desktop', 'Company Brain', '.env'),
  ];
  for (const p of extras) {
    if (existsSync(p)) return p;
  }
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    const p = join(dir, '.env');
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function estimateEmbedUsd(): number {
  // Two phases, each embedding PAGE_COUNT short docs plus QUERY_COUNT query vectors.
  const tokensPerPage = 80;
  const tokensPerQuery = 16;
  const phases = 2;
  const tokens = phases * (PAGE_COUNT * tokensPerPage + QUERY_COUNT * tokensPerQuery);
  return (tokens / 1_000_000) * EMBED_USD_PER_MILLION;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length) - 1;
  const idx = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[idx]!;
}

function searchHits(json: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(json)) return json as Array<Record<string, unknown>>;
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    for (const k of ['results', 'hits', 'items']) {
      if (Array.isArray(o[k])) return o[k] as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function isHit(hits: Array<Record<string, unknown>>, token: string): boolean {
  const needle = token.toLowerCase();
  return hits.some((h) => {
    const blob = [h.title, h.slug, h.chunk_text, h.text, h.id]
      .map((x) => String(x ?? '').toLowerCase())
      .join('\n');
    return blob.includes(needle);
  });
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(String);
}

function startServe() {
  return Bun.spawn(
    ['docker', 'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'gbrain-ops',
      'gbrain', 'serve', '--http', '--bind', MCP_BIND, '--port', String(MCP_PORT)],
    { stdout: 'pipe', stderr: 'pipe', cwd: ROOT },
  );
}

async function waitForServe(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const probe = await composeExec('gbrain-ops', [
      'bun', '-e',
      `const r = await fetch(${JSON.stringify(`${ISSUER_URL}/.well-known/gbrain`)}).catch(() => null); ` +
      'if (r && r.ok) console.log("ready");',
    ]);
    if (probe.stdout.includes('ready')) return;
    await Bun.sleep(1000);
  }
  throw new Error(`gbrain serve did not become ready at ${ISSUER_URL} within 60s`);
}

async function stopServe(local: ReturnType<typeof startServe>): Promise<void> {
  local.kill();
  await composeExec('gbrain-ops', [
    'bun', '-e',
    "const fs=require('fs'); for (const pid of fs.readdirSync('/proc')) { " +
    "if (!/^[0-9]+$/.test(pid) || Number(pid) === process.pid) continue; " +
    "try { const cmd = fs.readFileSync('/proc/'+pid+'/cmdline','utf8'); " +
    "if (cmd.indexOf('gbrain') >= 0 && cmd.indexOf('serve') >= 0) process.kill(Number(pid), 'SIGTERM'); " +
    "} catch (e) {} }",
  ]);
}

async function bunInOps(script: string, timeoutMs = 120_000) {
  return composeExec('gbrain-ops', ['bun', '-e', script], { timeoutMs });
}

async function seedRepo(dir: string, files: Array<{ name: string; body: string }>): Promise<void> {
  const script =
    `const fs=require('fs'); const {spawnSync}=require('child_process');` +
    `const dir=${JSON.stringify(dir)}; const files=${JSON.stringify(files)};` +
    `fs.mkdirSync(dir,{recursive:true}); process.chdir(dir);` +
    `spawnSync('git',['init','-q'],{stdio:'ignore'});` +
    `spawnSync('git',['config','user.email','mobrain@example.invalid']);` +
    `spawnSync('git',['config','user.name','mobrain']);` +
    `for (const f of files) fs.writeFileSync(f.name, f.body);` +
    `spawnSync('git',['add','-A']);` +
    `const staged=spawnSync('git',['diff','--cached','--quiet']);` +
    `if (staged.status!==0) spawnSync('git',['commit','-qm','seed'],{stdio:'ignore'});` +
    `console.log('seeded');`;
  const r = await bunInOps(script);
  if (r.exitCode !== 0 || !r.stdout.includes('seeded')) {
    throw new Error(`seed ${dir} failed: ${r.stderr || r.stdout}`);
  }
}

async function wipeProbeRepos(): Promise<void> {
  await bunInOps(
    `const fs=require('fs'); const {spawnSync}=require('child_process');` +
    `spawnSync('rm',['-rf','/srv/brain-repos/q1-mono',...Array.from({length:25},(_,i)=>'/srv/brain-repos/q1-s'+String(i+1).padStart(2,'0'))]);` +
    `console.log('wiped');`,
  );
}

async function countProbeRepos(): Promise<number> {
  const r = await bunInOps(
    `const fs=require('fs');` +
    `const names=fs.existsSync('/srv/brain-repos')?fs.readdirSync('/srv/brain-repos'):[];` +
    `console.log(names.filter(n=>n==='q1-mono'||/^q1-s\\d+$/.test(n)).length);`,
  );
  return Number(r.stdout.trim());
}

async function openaiKeyPresentInOps(): Promise<boolean> {
  const r = await composeExec('gbrain-ops', [
    'bun', '-e', 'console.log(process.env.OPENAI_API_KEY ? "present" : "missing")',
  ]);
  return r.stdout.includes('present');
}

async function ensureSlice0(): Promise<void> {
  const envFile = findEnvFile();
  if (envFile) loadDotEnv(envFile);
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is missing; load repo-root .env before running the probe');
  }
  await composeUp();
  if (!(await openaiKeyPresentInOps())) {
    const args = ['docker', 'compose', '-f', COMPOSE_FILE];
    if (envFile) args.push('--env-file', envFile);
    args.push('up', '-d', '--wait', '--force-recreate', 'gbrain-ops');
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', cwd: ROOT, env: { ...process.env } });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`force-recreate gbrain-ops failed (${exitCode}): ${stderr || stdout}`);
  }
  if (!(await openaiKeyPresentInOps())) {
    throw new Error('gbrain-ops still has no OPENAI_API_KEY after recreate');
  }
}

async function step(
  id: string,
  opId: string,
  values: ParamValues,
  opts: { json?: boolean; timeoutMs?: number; env?: Record<string, string> } = {},
) {
  const spec = OPERATIONS[opId];
  if (!spec) throw new Error(`unregistered operation ${opId}`);
  const t0 = Date.now();
  const r = await execOperation(spec, values, {
    json: opts.json, timeoutMs: opts.timeoutMs, env: opts.env,
  });
  const ms = Date.now() - t0;
  const ok = spec.okExitCodes.includes(r.exitCode);
  if (!ok) {
    console.error(`[${id}] exit ${r.exitCode} ${ms}ms\n${r.stderr || r.stdout}`);
    throw new Error(`${id} failed with exit ${r.exitCode}`);
  }
  console.log(`[${id}] ok ${ms}ms`);
  return { ...r, ms };
}

async function initBrain(): Promise<void> {
  await resetBrain();
  await wipeProbeRepos();
  await step('init', 'init', {
    nonInteractive: true, force: true, url: BRAIN_DB_URL, embeddingModel: EMBEDDING_MODEL,
  }, { timeoutMs: 900_000 });
  await step('config:search-mode', 'config.set', { key: 'search.mode', value: 'fast' });
}

function grantFederatedReadFromJson(json: unknown): number | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const grant = (o.grant && typeof o.grant === 'object') ? o.grant as Record<string, unknown> : o;
  const list = asStringArray(grant.federatedRead ?? grant.federated_read);
  return list ? list.length : null;
}

async function provisionReader(sourceIds: string[]): Promise<{
  env: Record<string, string>;
  requestedFederatedRead: number;
  grantFederatedRead: number | null;
  whoamiFederatedRead: number | null;
  whoamiTransport: string | null;
}> {
  const write = sourceIds[0]!;
  const credsFile = `/srv/gbrain-home/.creds-${CLIENT_NAME}.json`;
  const grant = await step('mcp.grant', 'mcp.grant', {
    name: CLIENT_NAME,
    harness: 'generic',
    profile: 'memory-reader',
    source: write,
    federatedRead: [...sourceIds],
    credentialsOut: credsFile,
    tokenTtl: '3600',
    url: MCP_URL,
  }, { json: true });

  const cat = await composeExec('gbrain-ops', ['cat', credsFile]);
  if (cat.exitCode !== 0) throw new Error(`could not read credential handoff: ${cat.stderr}`);
  const parsed = JSON.parse(cat.stdout) as { client_id: string; client_secret: string };
  const env = { GBRAIN_HOME: `/srv/gbrain-home/member-${CLIENT_NAME}` };
  await step('init.mcpOnly', 'init.mcpOnly', {
    issuerUrl: ISSUER_URL, mcpUrl: MCP_URL,
    oauthClientId: parsed.client_id, oauthClientSecret: parsed.client_secret, force: true,
  }, { json: true, env });

  const who = await step('whoami', 'whoami', {}, { json: true, env });
  const whoBody = who.json as { transport?: string; federated_read?: string[] } | null;
  const whoList = asStringArray(whoBody?.federated_read);
  return {
    env,
    requestedFederatedRead: sourceIds.length,
    grantFederatedRead: grantFederatedReadFromJson(grant.json),
    whoamiFederatedRead: whoList ? whoList.length : null,
    whoamiTransport: whoBody?.transport ?? null,
  };
}

async function timeSourcesStatus(): Promise<{ ms: number; count: number | null }> {
  const listed = await step('sources.list', 'sources.list', {}, { json: true });
  const listJson = listed.json as { sources?: unknown[] } | unknown[] | null;
  const count = Array.isArray(listJson)
    ? listJson.length
    : Array.isArray((listJson as { sources?: unknown[] } | null)?.sources)
      ? (listJson as { sources: unknown[] }).sources.length
      : null;
  const status = await step('sources.status', 'sources.status', {}, { json: true, timeoutMs: 180_000 });
  return { ms: status.ms, count };
}

async function runQueries(env: Record<string, string>, sourceByToken: Map<string, string>): Promise<SearchSample[]> {
  const samples: SearchSample[] = [];
  for (const q of QUERIES) {
    const t0 = Date.now();
    const r = await execOperation(OPERATIONS.search!, {
      query: q.query, limit: SEARCH_LIMIT,
    }, { json: true, env, timeoutMs: 120_000 });
    const ms = Date.now() - t0;
    const hits = searchHits(r.json);
    const hit = OPERATIONS.search!.okExitCodes.includes(r.exitCode) && isHit(hits, q.token);
    samples.push({
      query: q.query,
      token: q.token,
      sourceId: sourceByToken.get(q.token) ?? q.sourceId,
      ms,
      hit,
      exitCode: r.exitCode,
      hitCount: hits.length,
    });
    console.log(`[search] ${q.token} hit=${hit} hits=${hits.length} ${ms}ms`);
  }
  return samples;
}

async function runPhase(label: string, perSpace: boolean): Promise<PhaseReport> {
  console.log(`\n=== phase ${label} ===`);
  await initBrain();

  const sourceIds: string[] = [];
  if (perSpace) {
    for (const p of PAGES) {
      await seedRepo(`/srv/brain-repos/${p.id}`, [{ name: p.file, body: p.body }]);
      await step(`sources.add:${p.id}`, 'sources.add', {
        id: p.id, path: `/srv/brain-repos/${p.id}`, name: p.title,
      });
      sourceIds.push(p.id);
    }
  } else {
    await seedRepo(`/srv/brain-repos/${MONO_SOURCE}`, PAGES.map((p) => ({ name: p.file, body: p.body })));
    await step(`sources.add:${MONO_SOURCE}`, 'sources.add', {
      id: MONO_SOURCE, path: `/srv/brain-repos/${MONO_SOURCE}`, name: 'Open Q1 mono corpus',
    });
    sourceIds.push(MONO_SOURCE);
  }

  await step('sync:all', 'sync', { all: true }, { json: true, timeoutMs: 900_000 });
  const embed = await step('embed:stale', 'embed', { stale: true }, { json: true, timeoutMs: 900_000 });
  const status = await timeSourcesStatus();
  const repoCount = await countProbeRepos();

  const sourceByToken = new Map<string, string>(
    PAGES.map((p) => [p.token, perSpace ? p.id : MONO_SOURCE]),
  );

  const serve = startServe();
  try {
    await waitForServe();
    const reader = await provisionReader(sourceIds);
    const samples = await runQueries(reader.env, sourceByToken);
    const searchMs = samples.map((s) => s.ms);
    const hits = samples.filter((s) => s.hit).length;
    return {
      label,
      spaceCount: sourceIds.length,
      requestedFederatedRead: reader.requestedFederatedRead,
      grantFederatedRead: reader.grantFederatedRead,
      whoamiFederatedRead: reader.whoamiFederatedRead,
      whoamiTransport: reader.whoamiTransport,
      repoCount,
      sourcesListCount: status.count,
      sourcesStatusMs: status.ms,
      embedMs: embed.ms,
      searchMs,
      p95Ms: percentile(searchMs, 0.95),
      recall: samples.length === 0 ? 0 : hits / samples.length,
      hits,
      queries: samples.length,
      samples,
    };
  } finally {
    await stopServe(serve);
  }
}

function summarize(phase: PhaseReport): void {
  console.log(
    `[${phase.label}] spaces=${phase.spaceCount} repos=${phase.repoCount} ` +
    `federated_read requested=${phase.requestedFederatedRead} grant=${phase.grantFederatedRead} whoami=${phase.whoamiFederatedRead} ` +
    `sources.status=${phase.sourcesStatusMs}ms p95=${phase.p95Ms.toFixed(1)}ms ` +
    `recall=${phase.recall.toFixed(3)} (${phase.hits}/${phase.queries})`,
  );
}

export async function runScaleProbe(): Promise<ScaleProbeReport> {
  const estimatedEmbedUsd = estimateEmbedUsd();
  console.log(`[cost] estimated embed+query vectors ≈ $${estimatedEmbedUsd.toFixed(6)} (stop at $${MAX_SPEND_USD})`);
  if (estimatedEmbedUsd > MAX_SPEND_USD) {
    throw new Error(`estimated spend $${estimatedEmbedUsd} exceeds $${MAX_SPEND_USD} cap`);
  }

  await ensureSlice0();

  const baseline = await runPhase('1-space', false);
  summarize(baseline);
  const scale = await runPhase('25-space', true);
  summarize(scale);

  const latencyRatio = baseline.p95Ms > 0 ? scale.p95Ms / baseline.p95Ms : Number.POSITIVE_INFINITY;
  const recallRatio = baseline.recall > 0 ? scale.recall / baseline.recall : 0;
  const latencyPass = latencyRatio <= P95_LATENCY_BUDGET;
  const recallPass = recallRatio >= RECALL_FLOOR;
  const pass = latencyPass && recallPass;

  const report: ScaleProbeReport = {
    thresholds: { P95_LATENCY_BUDGET, RECALL_FLOOR },
    embeddingModel: EMBEDDING_MODEL,
    estimatedEmbedUsd,
    baseline,
    scale,
    latencyRatio,
    recallRatio,
    latencyPass,
    recallPass,
    pass,
  };

  if (!pass) {
    console.error('STOP AND ESCALATE: Open Q1 25-Space scale probe breached a C5 threshold.');
    console.error(`  latency ratio ${latencyRatio.toFixed(3)} (budget ${P95_LATENCY_BUDGET}×) pass=${latencyPass}`);
    console.error(`  recall ratio  ${recallRatio.toFixed(3)} (floor ${RECALL_FLOOR}×) pass=${recallPass}`);
  } else {
    console.log(`thresholds held: latency ${latencyRatio.toFixed(3)}× ≤ ${P95_LATENCY_BUDGET}, recall ${recallRatio.toFixed(3)}× ≥ ${RECALL_FLOOR}`);
  }
  return report;
}

if (import.meta.main) {
  try {
    const report = await runScaleProbe();
    const printable = {
      ...report,
      baseline: { ...report.baseline, samples: report.baseline.samples.map(({ query, token, ms, hit, hitCount, exitCode }) => ({ query, token, ms, hit, hitCount, exitCode })) },
      scale: { ...report.scale, samples: report.scale.samples.map(({ query, token, ms, hit, hitCount, exitCode }) => ({ query, token, ms, hit, hitCount, exitCode })) },
    };
    console.log(JSON.stringify(printable, null, 2));
    process.exit(report.pass ? 0 : 1);
  } catch (err) {
    console.error('BLOCKED:', err instanceof Error ? err.message : err);
    process.exit(2);
  }
}
