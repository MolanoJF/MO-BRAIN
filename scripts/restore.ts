#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callOps } from '../src/control/opsClient.ts';
import type { BackupManifest } from './backup.ts';

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
  await sh([...COMPOSE, 'stop', '-t', '90', 'gbrain-worker', 'gbrain-serve', 'control-plane'], 150_000);

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

  await sh([...COMPOSE, 'start', 'gbrain-serve', 'gbrain-worker', 'control-plane'], 180_000);
  await sh(
    [...COMPOSE, 'exec', '-T', 'gbrain-ops', 'gbrain', 'apply-migrations', '--yes', '--non-interactive'],
    600_000,
  );

  const doctor = await callOps('doctor', {}, { json: true, timeoutMs: 900_000 });

  // Slice 1 has no Connections yet; Slice 2 fills this list and drives the
  // automatic re-issue. The field ships now so the flow is not bolted on later.
  // auth.clients JSON is typically `{ clients: [...] }` or a bare array depending
  // on pin — accept both shapes.
  const clients = await callOps<unknown>('auth.clients', {}, { json: true, timeoutMs: 120_000 });
  const raw = clients.json;
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
