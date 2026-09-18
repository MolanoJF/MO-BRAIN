#!/usr/bin/env bun
/**
 * The 90-minute company-brain tutorial, unattended.
 * Covers docs/tutorials/company-brain.md Parts 2-5 and 11-12 — the parts that
 * are automatable today. Parts 6-10 (crons, skills, Slack, human onboarding)
 * are what brainstand replaces in Slices 2-4.
 *
 * Every gbrain invocation goes through the typed exec layer: argv arrays,
 * never shell strings (G2), with secrets redacted out of the report (S3c).
 * Seeding files/git into /srv/brain-repos legitimately needs a shell (`sh -c`
 * for mkdir/git/printf chains) — that never invokes `gbrain` itself, so it
 * stays outside G2's argv-array requirement.
 *
 * ── The isolation check is real, not theatre ──────────────────────────────
 * The original draft of this script ran `gbrain search ... --json` inside
 * gbrain-ops as the LOCAL ADMIN, identically for every simulated teammate,
 * and called the result "isolationOk." An admin identity sees every source
 * regardless of any grant, so that assertion could never go red — it proved
 * nothing about per-member scoping, which is the single most important
 * property Part 5 of the tutorial exists to demonstrate.
 *
 * This version exercises upstream's own mechanism for real:
 *   1. `mcp.grant` mints an OAuth client per teammate (source = their one
 *      write source, federatedRead = their read set) and writes a private
 *      credential handoff.
 *   2. `init.mcpOnly` (`gbrain init --mcp-only --issuer-url ... --mcp-url
 *      ... --oauth-client-id ... --oauth-client-secret ...`) installs that
 *      handoff as a thin-client config under a SEPARATE GBRAIN_HOME per
 *      member, running three LIVE pre-flight smokes (OAuth discovery, a
 *      client_credentials token round-trip, an MCP `initialize`) against a
 *      real `gbrain serve` — never touching GBRAIN_DATABASE_URL.
 *   3. `whoami` and `search`, run with that member's GBRAIN_HOME, are then
 *      transparently routed over MCP AS THAT OAUTH CLIENT. `whoami` must
 *      report `transport: "oauth"` with exactly that member's federated-read
 *      set; every `search` result's `source_id` must fall inside it.
 */
import { execOperation } from '../src/contracts/exec.ts';
import { OPERATIONS } from '../src/contracts/registry.ts';
import { composeExec } from '../src/docker/host.ts';
import type { ParamValues } from '../src/contracts/types.ts';

const COMPOSE_FILE = 'compose/docker-compose.slice0.yml';
const PG_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'change-me-in-a-real-deployment';
const BRAIN_DB_URL = `postgres://gbrain:${PG_PASSWORD}@postgres:5432/${process.env.GBRAIN_DB ?? 'gbrain'}`;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'openai:text-embedding-3-small';

const MCP_BIND = '127.0.0.1';
const MCP_PORT = 3131;
const MCP_URL = `http://${MCP_BIND}:${MCP_PORT}/mcp`;
const ISSUER_URL = `http://${MCP_BIND}:${MCP_PORT}`;

export type TutorialStep = { id: string; ok: boolean; exitCode: number; ms: number };
export type TutorialReport = { steps: TutorialStep[]; doctorExitCode: number; isolationOk: boolean };

const SOURCES = [
  { id: 'shared', name: 'Shared company wiki', file: 'widget-launch.md',
    printfBody: '# Widget launch plan\\n\\nShip the widget in March.\\n' },
  { id: 'customers', name: 'Customer notes', file: 'acme-notes.md',
    printfBody: '# Customer notes\\n\\nAcme wants faster onboarding.\\n' },
  { id: 'internal', name: 'Internal-only', file: 'performance-review.md',
    printfBody: '# Performance review process\\n\\nAnnual cycle runs in Q4.\\n' },
] as const;

// Each member writes ONE source and reads N — S4's model, expressed in the
// only shape the enforcement layer actually supports.
const MEMBERS = [
  { id: 'alice-example', write: 'customers', read: ['customers', 'shared'] },
  { id: 'bob-example', write: 'internal', read: ['internal', 'shared'] },
  { id: 'carol-example', write: 'shared', read: ['shared', 'customers', 'internal'] },
] as const;

// Crafted to match ONLY the 'internal' source's seeded page by title, so a
// leak is unambiguous: any member whose read set excludes 'internal' must
// see zero hits against it, and bob/carol (who DO read it) must see it.
const PROBE_QUERY = 'performance review';

function memberHome(id: string): string {
  return `/srv/gbrain-home/member-${id}`;
}

/** Start `gbrain serve`; the grant + isolation steps need a live target. */
function startServe() {
  return Bun.spawn(
    ['docker', 'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'gbrain-ops',
      'gbrain', 'serve', '--http', '--bind', MCP_BIND, '--port', String(MCP_PORT)],
    { stdout: 'pipe', stderr: 'pipe' },
  );
}

/** Poll rather than sleep blindly. bun fetch(), not curl — Work Item I. */
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

/**
 * Work Item L: `-T` docker-exec means `.kill()` on the local exec client
 * never propagates to the remote `gbrain serve` process it spawned. Reap
 * the remote PID directly by scanning /proc.
 */
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

export async function runTutorial(): Promise<TutorialReport> {
  const steps: TutorialStep[] = [];

  async function step(
    id: string,
    opId: string,
    values: ParamValues,
    opts: { json?: boolean; timeoutMs?: number; env?: Record<string, string> } = {},
  ) {
    const spec = OPERATIONS[opId];
    if (!spec) throw new Error(`unregistered operation ${opId} — add it to the registry with a contract test`);
    const t0 = Date.now();
    const r = await execOperation(spec, values, { json: opts.json, timeoutMs: opts.timeoutMs, env: opts.env });
    const ok = spec.okExitCodes.includes(r.exitCode);
    steps.push({ id, ok, exitCode: r.exitCode, ms: Date.now() - t0 });
    if (!ok) console.error(`[${id}] exit ${r.exitCode}\n${r.stderr}`);
    return r;
  }

  // --- Part 2: the brain backend is multi-user Postgres, initialized headlessly.
  await step('init', 'init', {
    nonInteractive: true, force: true, url: BRAIN_DB_URL, embeddingModel: EMBEDDING_MODEL,
  }, { timeoutMs: 900_000 });

  // V4: the search-mode cost matrix is a POST-init decision — ours to render.
  await step('config:search-mode', 'config.set', { key: 'search.mode', value: 'conservative' });

  // --- Part 3: carve the brain into sources. Space = source, hard rule (S4b).
  //
  // Work Item D (Task 7): `sources add --path` refuses a path that is not a
  // git repo with at least one COMMITTED, tracked file — content must be
  // seeded and committed BEFORE `sources add`, not after (the plan's
  // original draft called `sources add` on three freshly `git init`'d,
  // still-empty repos, which would have failed every single one of these
  // calls).
  //
  // Idempotency note: test/helpers/stack.ts's shared `resetBrain()` wipes
  // the DB schema and GBRAIN_HOME but deliberately leaves /srv/brain-repos
  // alone (other contract tests' fixtures live there too). Re-running this
  // script against a stack whose volumes were never recycled (no
  // intervening `compose down -v`) would otherwise hit an already-committed,
  // byte-identical file: `git commit` with nothing staged exits 1, which is
  // not this script's failure to report. `git add -A` is idempotent either
  // way; only commit when there is something to commit, since the
  // requirement `sources add` actually enforces is "at least one commit
  // exists," not "this script made a new one."
  for (const s of SOURCES) {
    const dir = `/srv/brain-repos/${s.id}`;
    const seed = await composeExec('gbrain-ops', ['sh', '-c',
      `set -e; mkdir -p ${dir}; cd ${dir}; git init -q; ` +
      `git config user.email mobrain@example.invalid; git config user.name mobrain; ` +
      `printf '${s.printfBody}' > ${s.file}; git add -A; ` +
      `git diff --cached --quiet || git commit -qm 'seed ${s.id}'`]);
    steps.push({ id: `seed:${s.id}`, ok: seed.exitCode === 0, exitCode: seed.exitCode, ms: 0 });

    // Work Item N (Task 12): `sources add` does not support --json, unlike
    // its list/status/archived siblings — confirmed empirically (exits 2,
    // "Unknown flag: --json"). Read the plain-text confirmation instead.
    await step(`sources:add:${s.id}`, 'sources.add', { id: s.id, path: dir, name: s.name });
  }

  // Sync imports COMMITS, not the working tree — that is why the loop above commits.
  await step('sync:all', 'sync', { all: true }, { json: true, timeoutMs: 900_000 });
  await step('embed:stale', 'embed', { stale: true }, { json: true, timeoutMs: 900_000 });
  await step('sources:status', 'sources.status', {}, { json: true });

  // --- Part 5 + the real isolation check. See the file header for why this
  // replaces the original local-admin `gbrain search` theatre.
  const serve = startServe();
  let isolationOk = true;
  try {
    await waitForServe();

    const creds: Record<string, { clientId: string; clientSecret: string }> = {};
    for (const m of MEMBERS) {
      const credsFile = `/srv/gbrain-home/.creds-${m.id}.json`;
      await step(`grant:${m.id}`, 'mcp.grant', {
        name: m.id, harness: 'generic', profile: 'memory-writer',
        source: m.write, federatedRead: [...m.read],
        credentialsOut: credsFile, tokenTtl: '3600', url: MCP_URL,
      }, { json: true });

      const cat = await composeExec('gbrain-ops', ['cat', credsFile]);
      if (cat.exitCode !== 0) throw new Error(`could not read the credential handoff for ${m.id}: ${cat.stderr}`);
      const parsed = JSON.parse(cat.stdout) as { client_id: string; client_secret: string };
      creds[m.id] = { clientId: parsed.client_id, clientSecret: parsed.client_secret };
    }

    for (const m of MEMBERS) {
      const env = { GBRAIN_HOME: memberHome(m.id) };
      const c = creds[m.id]!;

      // Real thin-client provisioning: three live pre-flight smokes against
      // the running `gbrain serve` (OAuth discovery, token round-trip, MCP
      // initialize) — never a local engine, never GBRAIN_DATABASE_URL.
      await step(`mcp-only-init:${m.id}`, 'init.mcpOnly', {
        issuerUrl: ISSUER_URL, mcpUrl: MCP_URL,
        oauthClientId: c.clientId, oauthClientSecret: c.clientSecret,
      }, { json: true, env });

      // Identity check: this must report the OAuth transport and exactly
      // this member's grant — never the local-admin identity.
      const who = await step(`whoami:${m.id}`, 'whoami', {}, { json: true, env });
      const whoBody = who.json as { transport?: string; source_id?: string; federated_read?: string[] } | null;
      const readSet = new Set<string>(m.read);
      const whoOk = Boolean(
        whoBody
        && whoBody.transport === 'oauth'
        && whoBody.source_id === m.write
        && Array.isArray(whoBody.federated_read)
        && whoBody.federated_read.length === readSet.size
        && whoBody.federated_read.every((s) => readSet.has(s)),
      );
      steps.push({ id: `whoami-scope:${m.id}`, ok: whoOk, exitCode: who.exitCode, ms: 0 });
      if (!whoOk) {
        isolationOk = false;
        console.error(`[isolation] ${m.id} whoami reported an unexpected identity: ${JSON.stringify(whoBody)}`);
      }

      // The scoping proof: every result's source_id must fall inside this
      // member's OWN federated-read grant — not gbrain-ops's local view.
      const probe = await step(`search:${m.id}`, 'search', { query: PROBE_QUERY }, { json: true, env });
      const results = Array.isArray(probe.json) ? (probe.json as Array<Record<string, unknown>>) : [];
      const seenSourceIds = results
        .map((r) => (r.source_id ?? r.sourceId) as string | undefined)
        .filter((sid): sid is string => typeof sid === 'string' && sid.length > 0);
      const leaked = seenSourceIds.filter((sid) => !readSet.has(sid));
      // Absence-of-leak alone would trivially "pass" if scoping were broken
      // in the OTHER direction (blocks everything, returns nothing for
      // anyone) — a false sense of security from an empty result set. Since
      // PROBE_QUERY is crafted to match the 'internal' source's seeded page
      // by title, a member who CAN read 'internal' must actually see it:
      // this is the positive half of the proof, not just the negative half.
      const positiveProofOk = !readSet.has('internal') || seenSourceIds.includes('internal');
      const scopedOk = leaked.length === 0 && positiveProofOk;
      steps.push({ id: `isolation:${m.id}`, ok: scopedOk, exitCode: 0, ms: 0 });
      if (leaked.length > 0) {
        isolationOk = false;
        console.error(`[isolation] ${m.id} saw results from ${[...new Set(leaked)].join(',')}`);
      }
      if (!positiveProofOk) {
        isolationOk = false;
        console.error(`[isolation] ${m.id} can read 'internal' but the probe query returned no internal hit — scoping may be fail-closed instead of correctly scoped`);
      }
    }
  } finally {
    await stopServe(serve);
  }

  // --- Part 12: operating the brain. V6 makes this a real gate.
  const doctor = await execOperation(OPERATIONS.doctor!, {}, { json: true, timeoutMs: 900_000 });
  steps.push({ id: 'doctor', ok: doctor.exitCode === 0, exitCode: doctor.exitCode, ms: 0 });

  return { steps, doctorExitCode: doctor.exitCode, isolationOk };
}

if (import.meta.main) {
  const report = await runTutorial();
  console.log(JSON.stringify(report, null, 2));
  const failed = report.steps.filter((s) => !s.ok);
  if (failed.length > 0 || report.doctorExitCode !== 0 || !report.isolationOk) process.exit(1);
}
