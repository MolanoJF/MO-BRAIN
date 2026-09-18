#!/usr/bin/env bun
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultOpsCaller, type OpsCaller } from '../src/control/opsCaller.ts';

export type QuiesceState = 'verified' | 'unverified' | 'failed';

export type BackupManifest = {
  id: string;
  createdAt: string;
  gbrainVersion: string;
  components: { brainDb: string; controlDb: string; brainRepos: string; secrets: string };
  sha256: Record<string, string>;
  quiesced: QuiesceState;
  quiesceLane: 'http' | 'relay' | null;
  warning: string;
};

// --env-file .env when present (local); CI supplies the same vars in the job
// env. Project dir stays compose/ so ./Caddyfile and ./initdb resolve.
// (--project-directory . would break those relative mounts.)
const COMPOSE = [
  'docker', 'compose',
  ...(existsSync('.env') ? ['--env-file', '.env'] as const : []),
  '-f', 'compose/docker-compose.yml',
];

/** Posted by the control-plane when docker compose is unavailable in-process (Ruling 31). */
export const BACKUP_HOST_ONLY_ERROR =
  'Backup is a host operation. Run scripts/backup.ts on the Docker host — ' +
  'the control-plane container cannot invoke docker compose.';

/**
 * True when this process can exec `docker compose` (host CLI / install path).
 * False inside the production control-plane image (no Docker CLI) — callers
 * must fail closed with 503 rather than a raw spawn ENOENT 500.
 */
export async function dockerComposeUsable(): Promise<boolean> {
  try {
    // Pass env explicitly so a test (or caller) that narrows PATH is honoured —
    // on Windows Bun.spawn otherwise keeps the process's original PATH.
    // Do not load the project compose file — version alone proves the CLI.
    const p = Bun.spawn(['docker', 'compose', 'version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });
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

async function sh(argv: string[], timeoutMs = 900_000): Promise<{ exitCode: number; stderr: string }> {
  const p = Bun.spawn(argv, { stdout: 'inherit', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [stderr, exitCode] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { exitCode, stderr };
}

/** Capture a command's stdout to a file — argv array only, no shell redirect (S2). */
async function captureToFile(argv: string[], outPath: string, timeoutMs = 900_000): Promise<void> {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).arrayBuffer(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (exitCode !== 0) throw new Error(`${argv.slice(0, 6).join(' ')}… failed (${exitCode}): ${stderr}`);
    await writeFile(outPath, Buffer.from(stdout));
  } finally {
    clearTimeout(timer);
  }
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/**
 * Honesty rule: a probe that could not run did not succeed.
 *
 * The previous shape was `let quiesced = true` with `catch { quiesced = true }`
 * (scripts/backup.ts:104-108) reached through a client whose default URL is the
 * CONTAINER NAME `http://gbrain-ops:3140`. On a production host that name does
 * not resolve and no ops port is published (S2), so the probe ALWAYS threw and
 * every production manifest claimed a quiesce nobody checked.
 */
export function classifyQuiesce(
  status: { running: boolean; workers: unknown[] } | null,
  error: unknown,
  caller: { kind: 'http' | 'relay' | 'stub' },
): { quiesced: QuiesceState; quiesceLane: 'http' | 'relay' | null } {
  if (error !== null && error !== undefined) return { quiesced: 'unverified', quiesceLane: null };
  if (status === null) return { quiesced: 'unverified', quiesceLane: null };
  const lane = caller.kind === 'http' || caller.kind === 'relay' ? caller.kind : null;
  return { quiesced: status.running ? 'failed' : 'verified', quiesceLane: lane };
}

/**
 * Quiesce first. A pg_dump of two databases plus a tar of two volumes taken
 * at three moments is three artifacts that disagree: a job commits a page to
 * the repo, then writes its row; the tar ran before the commit and the dump
 * after; restore yields a row pointing at a nonexistent file.
 *
 * On the VM target, prefer a volume- or VM-layer snapshot (ZFS/btrfs or a
 * cloud disk snapshot) so atomicity across DB + files is structural. This is
 * the portable minimum.
 */
export async function runBackup(
  outDir: string,
  opts: { ops?: OpsCaller; allowUnquiesced?: boolean } = {},
): Promise<BackupManifest> {
  await mkdir(outDir, { recursive: true });
  const id = randomUUID();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  // V5: SIGTERM drains; `stop` waits up to 40s. Budget 90s.
  await sh([...COMPOSE, 'stop', '-t', '90', 'scheduler', 'gbrain-worker'], 120_000);

  try {
    const ops = opts.ops ?? (await defaultOpsCaller(COMPOSE));
    let status: { running: boolean; workers: unknown[] } | null = null;
    let probeError: unknown = null;
    try { status = await ops.supervisorStatus(); } catch (e) { probeError = e; }
    const { quiesced, quiesceLane } = classifyQuiesce(status, probeError, ops);

    if (quiesced === 'failed') {
      throw new Error(
        'Refusing to back up: the job supervisor is still running after `compose stop`. ' +
        'A dump taken now can disagree with the repos. Investigate before retrying.',
      );
    }
    if (quiesced === 'unverified' && !opts.allowUnquiesced) {
      throw new Error(
        'Refusing to back up: could not verify the stack is quiesced ' +
        `(lane=${ops.kind}${probeError ? `, error=${(probeError as Error).message}` : ''}). ` +
        'An unverified quiesce can produce a dump that disagrees with the repos. ' +
        'Re-run with --allow-unquiesced to take it anyway; the manifest will say so.',
      );
    }

    const components = {
      brainDb: `brain-${stamp}.sql`,
      controlDb: `control-${stamp}.sql`,
      brainRepos: `brain-repos-${stamp}.tar`,
      secrets: `secrets-${stamp}.sql`,
    };

    const dump = async (db: string, file: string, extra: string[] = []) => {
      await captureToFile(
        [...COMPOSE, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'gbrain', '-d', db, ...extra],
        join(outDir, file),
      );
    };

    await dump('gbrain', components.brainDb);
    await dump('control', components.controlDb);
    // The secrets table separately, so restore can re-materialize credentials
    // without a full control-DB restore.
    await dump('control', components.secrets, ['-t', 'secrets']);

    await captureToFile(
      [...COMPOSE, 'exec', '-T', 'gbrain-ops', 'tar', '-cf', '-', '-C', '/srv/brain-repos', '.'],
      join(outDir, components.brainRepos),
    );

    // The git remotes are the real durable copy of a Space's content.
    await sh([...COMPOSE, 'exec', '-T', 'gbrain-ops', 'gbrain', 'sources', 'push', '--all'], 600_000)
      .catch(() => undefined);

    const sums: Record<string, string> = {};
    for (const [k, f] of Object.entries(components)) sums[k] = await sha256(join(outDir, f));

    const manifest: BackupManifest = {
      id, createdAt: new Date().toISOString(),
      gbrainVersion: process.env.GBRAIN_VERSION ?? '0.50.0.0',
      components, sha256: sums, quiesced, quiesceLane,
      warning:
        'Restoring requires the ENCRYPTION_KEY that sealed the secrets table. ' +
        'Store it separately from this archive — together they are a credential dump. ' +
        'Restoring to a NEW DOMAIN invalidates every OAuth grant; re-provision all Connections.' +
        (quiesced === 'unverified'
          ? ' WARNING: the stack quiesce is unverified — this archive may not be consistent.'
          : ''),
    };

    await Bun.write(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } finally {
    await sh([...COMPOSE, 'start', 'gbrain-worker', 'scheduler'], 120_000);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const allowUnquiesced = args.includes('--allow-unquiesced');
  const out = args.find((a) => !a.startsWith('--')) ?? `./backups/${new Date().toISOString().slice(0, 10)}`;
  console.log(JSON.stringify(await runBackup(out, { allowUnquiesced }), null, 2));
}
