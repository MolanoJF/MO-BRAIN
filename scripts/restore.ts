#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scrubOutput } from '../src/docker/host.ts';
import { open } from '../src/control/secrets.ts';
import type { BackupManifest } from './backup.ts';

/** Per-stream cap. A doctor dump must never bloat a log or a report. */
const EXCERPT_CAP = 4_000;

/**
 * Bounded, credential-scrubbed excerpt of captured command output. `ok` is
 * doctor's exit code alone, so a red run has to say WHY on the spot: the two
 * streams are captured (never inherited), and an unredacted one would put a
 * postgres URL or a `client_secret` into the restore record (S3c).
 */
function excerpt(stdout: string, stderr: string): string {
  const clean = scrubOutput([stdout, stderr].join('\n')).trim();
  return clean.length > EXCERPT_CAP
    ? `${clean.slice(0, EXCERPT_CAP)}\n… truncated (${clean.length - EXCERPT_CAP} more characters)`
    : clean;
}

/**
 * Every non-ok doctor check as `status name: message`. The full JSON is tens of
 * KB and its failures sit anywhere in the array, so an excerpt taken from the
 * head of the stream can show 100 green checks and hide the one that failed.
 */
function failingChecks(stdout: string): string[] {
  const raw = parseLastJson(stdout);
  if (!raw || typeof raw !== 'object' || !('checks' in raw)) return [];
  const checks: unknown[] = Array.isArray(raw.checks) ? raw.checks : [];
  return checks.flatMap((c) => {
    if (!c || typeof c !== 'object') return [];
    const status = 'status' in c ? c.status : undefined;
    if (status === 'ok') return [];
    const name = 'name' in c ? c.name : undefined;
    const message = 'message' in c ? c.message : undefined;
    return [`${String(status)} ${String(name)}: ${String(message ?? '')}`];
  });
}

/** Why doctor's exit code was non-zero, bounded and scrubbed. */
function doctorPostmortem(stdout: string, stderr: string): string {
  const failures = failingChecks(stdout);
  // The named checks are the point; fall back to the raw stdout only when the
  // JSON did not parse (a doctor that died before printing anything).
  return excerpt(failures.length > 0 ? failures.join('\n') : stdout, stderr);
}

export type RestoreReport = {
  ok: boolean;
  components: string[];
  doctorExitCode: number;
  connectionsNeedingReissue: string[];
  domainChanged: boolean;
};

// --env-file .env when present (local); CI supplies the same vars in the job
// env. Project dir stays compose/ so ./Caddyfile and ./initdb resolve.
const COMPOSE = [
  'docker', 'compose',
  ...(existsSync('.env') ? ['--env-file', '.env'] as const : []),
  '-f', 'compose/docker-compose.yml',
];

async function sh(argv: string[], timeoutMs = 900_000): Promise<{ exitCode: number; stderr: string }> {
  const p = Bun.spawn(argv, { stdout: 'inherit', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [stderr, exitCode] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { exitCode, stderr };
}

/** Capture stdout+stderr — argv array only. Used for in-compose gbrain ops
 *  (doctor / auth.clients): production publishes no ops host port (S2). */
async function shCapture(
  argv: string[],
  timeoutMs = 900_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** Last balanced JSON value on stdout (gbrain may emit progress first). */
function parseLastJson(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  const start = Math.min(
    ...[trimmed.indexOf('{'), trimmed.indexOf('[')].filter((i) => i >= 0),
  );
  if (!Number.isFinite(start) || start < 0) return null;
  try {
    return JSON.parse(trimmed.slice(start)) as unknown;
  } catch {
    return null;
  }
}

/** Feed a host file to a command's stdin — argv array only, no shell redirect (S2). */
async function feedFile(
  argv: string[],
  filePath: string,
  timeoutMs = 900_000,
): Promise<{ exitCode: number; stderr: string }> {
  const p = Bun.spawn(argv, {
    stdin: Bun.file(filePath),
    stdout: 'inherit',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stderr, exitCode] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    return { exitCode, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** Feed text to a command's stdin — argv array only, and the text never
 *  reaches argv: a credential in argv is a credential in `ps` (S3c). */
async function feedString(
  argv: string[],
  input: string,
  timeoutMs = 120_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    await p.stdin.write(input);
    await p.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** One single-value `-tAc` read from a restored database. */
async function scalar(db: 'gbrain' | 'control', sql: string): Promise<string> {
  const r = await shCapture(
    [...COMPOSE, 'exec', '-T', 'postgres', 'psql', '-U', 'gbrain', '-d', db, '-tAc', sql],
    120_000,
  );
  if (r.exitCode !== 0) throw new Error(`psql read ${db} failed: ${excerpt('', r.stderr)}`);
  return r.stdout.trim();
}

/**
 * Writes the file-plane patch through the ops HTTP route. It has to be the ops
 * route, not a file write: every file-plane write serializes through gbrain-ops
 * behind the control DB's advisory lock (break-glass.md — an unlocked edit can
 * lose an API key). 3140 is the loopback inside the container; production
 * publishes no ops host port (S2).
 */
const FILE_PLANE_PATCH_PROGRAM = `
let input = '';
for await (const chunk of process.stdin) input += chunk;
const base = process.env.OPS_RPC_URL ?? 'http://127.0.0.1:3140';
const res = await fetch(base + '/fileplane/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPS_RPC_TOKEN },
  body: JSON.stringify({ patch: JSON.parse(input) }),
});
// Status only: this write carries a credential and the response is not worth a
// log line that could echo one back (S3c). The caller reports the key names.
if (!res.ok) { console.error('fileplane/config -> ' + res.status); process.exit(1); }
`;

/**
 * Re-derive the gbrain FILE plane (GBRAIN_HOME/.gbrain/config.json) from the
 * control DB we just restored.
 *
 * gbrain resolves the embedding pin — `embedding_model` + `embedding_dimensions`,
 * the pair that sizes the schema — from the file plane and NEVER from the DB
 * plane (gbrain's core/config-db-merge.ts refuses to merge those two keys). The
 * archive carries no file plane on purpose: it holds the provider key and the
 * DB URL in the clear (V9/S3c). So a wipe-and-restore used to leave the brain
 * resolving gbrain's shipped default, `zeroentropyai:zembed-1`, which went past
 * its 2026-09-04 sunset: the vectors came back while the brain that made them
 * did not, and `gbrain doctor` failed provider_sunset — semantic retrieval
 * offline, with the fix sitting in the archive's own control dump.
 *
 * Both halves are in that dump: brains.embedding_model pins the model, the
 * sealed secret carries the key. A brain the console never provisioned has no
 * pin, so there is nothing to write and this is a no-op.
 */
async function reMaterializeFilePlane(): Promise<void> {
  const model = await scalar('control',
    'select coalesce((select embedding_model from brains where embedding_model is not null' +
    ' order by created_at limit 1), \'\')');
  // The restored column, not the model's recipe, owns the width: it is what the
  // surviving vectors were written into, and a mismatch refuses new embeds.
  const width = Number(await scalar('gbrain',
    'select coalesce((select atttypmod from pg_attribute' +
    ' where attrelid = to_regclass(\'public.content_chunks\') and attname = \'embedding\'' +
    ' and atttypmod > 0), 0)'));

  const patch: Record<string, string | number> = {};
  // The pin is a pair — the model names the provider, the column width sizes the
  // schema — so write both or neither: a model pinned alone would resolve its
  // own width against vectors that are not in it.
  if (model && Number.isInteger(width) && width > 0) {
    patch.embedding_model = model;
    patch.embedding_dimensions = width;
  }

  // The wizard names the secret after the model's vendor: openai:* → openai_api_key.
  const provider = model.split(':')[0] ?? '';
  if (/^[a-z0-9_]+$/.test(provider)) {
    const sealed = await scalar('control',
      `select salt || '|' || wrapped_dek || '|' || payload from secrets` +
      ` where name = '${provider}_api_key' order by version desc limit 1`);
    if (sealed) {
      const [salt, wrappedDek, payload] = sealed.split('|');
      if (salt && wrappedDek && payload) {
        patch[`${provider}_api_key`] = open({ version: 1, salt, wrappedDek, payload });
      }
    }
  }
  if (Object.keys(patch).length === 0) return;

  const write = await feedString(
    [...COMPOSE, 'exec', '-T', 'gbrain-ops', 'bun', '-e', FILE_PLANE_PATCH_PROGRAM],
    JSON.stringify(patch),
  );
  if (write.exitCode !== 0) {
    throw new Error(`file plane re-materialization failed: ${excerpt(write.stdout, write.stderr)}`);
  }
  // Key NAMES only: a value printed here would be the credential (S3c).
  console.log(`[restore] re-materialized the gbrain file plane: ${Object.keys(patch).join(', ')}`);
}

/**
 * Restore is a console flow, not a README script: restore both databases,
 * re-materialize secrets, then re-issue credentials for every Connection —
 * gbrain hashes client secrets server-side, so restoring cannot recover them.
 * The re-issue step is the part nobody expects, so we do it automatically and
 * show which agents need a config refresh.
 */
export async function runRestore(dir: string, opts: { newDomain?: string } = {}): Promise<RestoreReport> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as BackupManifest;

  if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is required to restore: it is held separately from the archive');
  }

  // Stop everything that writes before touching the databases.
  await sh([...COMPOSE, 'stop', '-t', '90', 'scheduler', 'gbrain-worker', 'gbrain-serve', 'control-plane'], 150_000);

  const restoreDb = async (db: string, file: string) => {
    // WITH (FORCE) so gbrain-ops' open connections cannot block DROP (PG 13+).
    const drop = await sh([
      ...COMPOSE, 'exec', '-T', 'postgres',
      'psql', '-U', 'gbrain', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
      '-c', `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`,
    ]);
    if (drop.exitCode !== 0) throw new Error(`drop ${db} failed: ${drop.stderr}`);

    const create = await sh([
      ...COMPOSE, 'exec', '-T', 'postgres',
      'psql', '-U', 'gbrain', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
      '-c', `CREATE DATABASE ${db}`,
    ]);
    if (create.exitCode !== 0) throw new Error(`create ${db} failed: ${create.stderr}`);

    const load = await feedFile(
      [...COMPOSE, 'exec', '-T', 'postgres', 'psql', '-U', 'gbrain', '-d', db, '-v', 'ON_ERROR_STOP=1'],
      join(dir, file),
    );
    if (load.exitCode !== 0) throw new Error(`restore ${db} failed: ${load.stderr}`);
  };

  await restoreDb('gbrain', manifest.components.brainDb);
  await restoreDb('control', manifest.components.controlDb);

  const tar = await feedFile(
    [...COMPOSE, 'exec', '-T', 'gbrain-ops', 'tar', '-xf', '-', '-C', '/srv/brain-repos'],
    join(dir, manifest.components.brainRepos),
  );
  if (tar.exitCode !== 0) throw new Error(`repo restore failed: ${tar.stderr}`);

  // Before the services start: gbrain-serve and gbrain-worker read the pin once,
  // at boot, and a worker booted on the default model would embed into a column
  // it does not match.
  await reMaterializeFilePlane();

  await sh([...COMPOSE, 'start', 'gbrain-serve', 'gbrain-worker', 'control-plane', 'scheduler'], 180_000);
  await sh(
    [...COMPOSE, 'exec', '-T', 'gbrain-ops', 'gbrain', 'apply-migrations', '--yes', '--non-interactive'],
    600_000,
  );

  // Production gbrain-ops publishes no host port (S2). Doctor / auth.clients
  // must run via compose exec argv — never host callOps / OPS_RPC_URL.
  const doctor = await shCapture(
    [...COMPOSE, 'exec', '-T', 'gbrain-ops', 'gbrain', 'doctor', '--json'],
    900_000,
  );

  // `ok` below is this exit code and nothing else, so a non-zero one must name
  // the failing check there and then. stdio is captured here, not inherited:
  // without this line a red restore says only "exit 1" and the cause is lost.
  if (doctor.exitCode !== 0) {
    console.error(
      `[restore] gbrain doctor exited ${doctor.exitCode} on the restored stack:\n` +
        `${doctorPostmortem(doctor.stdout, doctor.stderr)}\n`,
    );
  }

  // Slice 1 has no Connections yet; Slice 2 fills this list and drives the
  // automatic re-issue. The field ships now so the flow is not bolted on later.
  // auth.clients JSON is typically `{ clients: [...] }` or a bare array depending
  // on pin — accept both shapes.
  const clients = await shCapture(
    [...COMPOSE, 'exec', '-T', 'gbrain-ops', 'gbrain', 'auth', 'clients', '--json'],
    120_000,
  );
  const raw = parseLastJson(clients.stdout);
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { clients?: unknown[] }).clients))
      ? (raw as { clients: unknown[] }).clients
      : [];
  const connectionsNeedingReissue = list
    .map((c) => {
      if (!c || typeof c !== 'object') return '';
      const row = c as { client_id?: unknown; clientId?: unknown; id?: unknown };
      return String(row.client_id ?? row.clientId ?? row.id ?? '');
    })
    .filter(Boolean);

  return {
    ok: doctor.exitCode === 0,
    components: Object.keys(manifest.components),
    doctorExitCode: doctor.exitCode,
    connectionsNeedingReissue,
    domainChanged: Boolean(opts.newDomain),
  };
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: bun run scripts/restore.ts <backup-dir>'); process.exit(2); }
  const report = await runRestore(dir, { newDomain: process.env.NEW_DOMAIN });
  console.log(JSON.stringify(report, null, 2));
  if (report.domainChanged) {
    console.error('\nRestored to a NEW DOMAIN: every OAuth grant is invalid — ' +
      'OAuth redirect URIs and issuer URLs are domain-bound. Re-provision all Connections.');
  }
  if (!report.ok) process.exit(1);
}
