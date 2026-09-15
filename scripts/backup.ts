#!/usr/bin/env bun
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callOps } from '../src/control/opsClient.ts';

export type BackupManifest = {
  id: string;
  createdAt: string;
  gbrainVersion: string;
  components: { brainDb: string; controlDb: string; brainRepos: string; secrets: string };
  sha256: Record<string, string>;
  quiesced: boolean;
  warning: string;
};

// --project-directory . so Compose loads the repo-root .env (with -f alone
// the project dir becomes compose/ and required vars fail interpolation).
const COMPOSE = [
  'docker', 'compose', '--project-directory', '.', '-f', 'compose/docker-compose.yml',
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
 * Quiesce first. A pg_dump of two databases plus a tar of two volumes taken
 * at three moments is three artifacts that disagree: a job commits a page to
 * the repo, then writes its row; the tar ran before the commit and the dump
 * after; restore yields a row pointing at a nonexistent file.
 *
 * On the VM target, prefer a volume- or VM-layer snapshot (ZFS/btrfs or a
 * cloud disk snapshot) so atomicity across DB + files is structural. This is
 * the portable minimum.
 */
export async function runBackup(outDir: string): Promise<BackupManifest> {
  await mkdir(outDir, { recursive: true });
  const id = randomUUID();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  // V5: SIGTERM drains; `stop` waits up to 40s. Budget 90s.
  await sh([...COMPOSE, 'stop', '-t', '90', 'gbrain-worker'], 120_000);
  let quiesced = true;
  try {
    const status = await callOps('jobs.supervisorStatus', {}, { json: true, timeoutMs: 30_000 });
    quiesced = status.exitCode === 1; // 1 = not running
  } catch { quiesced = true; }

  try {
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
      components, sha256: sums, quiesced,
      warning:
        'Restoring requires the ENCRYPTION_KEY that sealed the secrets table. ' +
        'Store it separately from this archive — together they are a credential dump. ' +
        'Restoring to a NEW DOMAIN invalidates every OAuth grant; re-provision all Connections.',
    };

    await Bun.write(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } finally {
    await sh([...COMPOSE, 'start', 'gbrain-worker'], 120_000);
  }
}

if (import.meta.main) {
  const out = process.argv[2] ?? `./backups/${new Date().toISOString().slice(0, 10)}`;
  console.log(JSON.stringify(await runBackup(out), null, 2));
}
