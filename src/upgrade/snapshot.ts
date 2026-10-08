import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SnapshotManifest } from './types.ts';
import { buildManifest, verifyManifest } from './manifest.ts';

/**
 * The four artifacts D3 defines. `SnapshotContext.databases`/`.volumes`
 * default to these in production (Task 11); Gate A (Task 15) overrides both
 * with a single throwaway volume so the driver's own argv path is exercised
 * against a scratch volume, never a product service.
 */
export const SNAPSHOT_DATABASES = ['gbrain', 'control'] as const;

/**
 * D4 — the compose project name is DATA, not branding.
 *
 * Docker derives volume names from it (`<project>_<volume>`), so changing it
 * orphans an existing deployment's data. The default is therefore FROZEN at
 * the legacy value forever, whatever the product ends up being called, and the
 * variable exists so that (a) the rename in Task 4 cannot silently strand
 * anyone's brain, and (b) two stacks can be co-resident on one host.
 */
export const LEGACY_PROJECT_NAME = 'brainstand';

export function projectName(): string {
  const raw = process.env.COMPOSE_PROJECT_NAME?.trim();
  return raw && raw.length > 0 ? raw : LEGACY_PROJECT_NAME;
}

const VOLUME_SUFFIXES = ['brain-repos', 'gbrain-home'] as const;

export function snapshotVolumes(): readonly string[] {
  return VOLUME_SUFFIXES.map((s) => `${projectName()}_${s}`);
}

export function volumeLabel(volume: string): string {
  const prefix = `${projectName()}_`;
  return volume.startsWith(prefix) ? volume.slice(prefix.length) : volume;
}

const DB_ARTIFACT_NAME: Record<string, string> = { gbrain: 'brain-db', control: 'control-db' };
const VOLUME_ARTIFACT_NAME: Record<string, string> = {
  'brainstand_brain-repos': 'brain-repos',
  'brainstand_gbrain-home': 'gbrain-home',
};
const artifactNameForDb = (db: string): string => DB_ARTIFACT_NAME[db] ?? db;
const artifactNameForVolume = (volume: string): string => VOLUME_ARTIFACT_NAME[volume] ?? volume;
const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, '_');

// Mirrors scripts/backup.ts:21-25 exactly — this is that file's successor.
const DEFAULT_COMPOSE = [
  'docker', 'compose',
  ...(existsSync('.env') ? ['--env-file', '.env'] : []),
  '-f', 'compose/docker-compose.yml',
];

/**
 * What a snapshot needs to know — deliberately NOT the full `UpgradeContext`
 * (Task 4/11: runId, fromVersion, toVersion, dryRun, upgradeDir, envPath,
 * compose, journal, now). Task 11's own `RunDeps.snapshot(ctx, drain)`
 * wrapper projects the big context down to this one before calling take().
 */
export type SnapshotContext = {
  runId: string;
  volumes: readonly string[];
  databases: readonly string[];
  outDir: string;
  /** docker compose argv prefix. Defaults to the production stack. */
  compose?: readonly string[];
};

export type RunResult = { exitCode: number; stdout: string; stderr: string };

/** The seam a fake occupies in tests; production wires real Bun.spawn calls. */
export type Runner = {
  run(argv: string[], timeoutMs?: number): Promise<RunResult>;
  captureToFile(argv: string[], outPath: string, timeoutMs?: number): Promise<void>;
  feedFile(argv: string[], inputPath: string, timeoutMs?: number): Promise<RunResult>;
};

async function bunRun(argv: string[], timeoutMs = 900_000): Promise<RunResult> {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

async function bunCaptureToFile(argv: string[], outPath: string, timeoutMs = 900_000): Promise<void> {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited,
    ]);
    if (exitCode !== 0) throw new Error(`${argv.slice(0, 6).join(' ')}… failed (${exitCode}): ${stderr}`);
    await writeFile(outPath, new Uint8Array(stdout));
  } finally { clearTimeout(timer); }
}

async function bunFeedFile(argv: string[], inputPath: string, timeoutMs = 900_000): Promise<RunResult> {
  const p = Bun.spawn(argv, { stdin: Bun.file(inputPath), stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

const defaultRunner: Runner = { run: bunRun, captureToFile: bunCaptureToFile, feedFile: bunFeedFile };

/** `pg_dump` of one database, through the ONE process quiesce() leaves alive. */
export async function dumpDatabase(
  runner: Runner, compose: readonly string[], db: string, outPath: string,
): Promise<void> {
  await runner.captureToFile(
    [...compose, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'gbrain', '-d', db], outPath,
  );
}

/** `psql` drop+create+load, same shape as scripts/restore.ts:265-286. */
export async function restoreDatabase(
  runner: Runner, compose: readonly string[], db: string, dumpPath: string,
): Promise<void> {
  const psql = (sql: string) => runner.run([
    ...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'gbrain', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-c', sql,
  ]);
  const drop = await psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  if (drop.exitCode !== 0) throw new Error(`drop ${db} failed: ${drop.stderr}`);
  const create = await psql(`CREATE DATABASE ${db}`);
  if (create.exitCode !== 0) throw new Error(`create ${db} failed: ${create.stderr}`);
  const load = await runner.feedFile(
    [...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'gbrain', '-d', db, '-v', 'ON_ERROR_STOP=1'],
    dumpPath,
  );
  if (load.exitCode !== 0) throw new Error(`restore ${db} failed: ${load.stderr}`);
}

/**
 * A throwaway `busybox` container mounts the named volume directly (D3) — no
 * service needs to be running. This is the seam Slice 5's VM/ZFS driver
 * replaces; it must not grow a second gbrain-facing implementation now.
 */
export async function tarVolumeToFile(
  runner: Runner, volume: string, outDir: string, fileName: string,
): Promise<void> {
  const r = await runner.run([
    'docker', 'run', '--rm',
    '-v', `${volume}:/src:ro`, '-v', `${outDir}:/out`,
    'busybox', 'tar', 'cf', `/out/${fileName}`, '-C', '/src', '.',
  ], 900_000);
  if (r.exitCode !== 0) throw new Error(`tar of ${volume} failed (${r.exitCode}): ${r.stderr}`);
  // Docker writes a bind-mounted file as root. Hand the artifact back to the
  // invoking user so an operator (and the A9 tamper test) can move, verify or
  // delete it without sudo. The tar still runs as root so volume files with
  // restrictive modes stay readable; only the output is chowned. On hosts with
  // no POSIX uid (Windows) there is nothing to chown.
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined && gid !== undefined) {
    const c = await runner.run([
      'docker', 'run', '--rm', '-v', `${outDir}:/out`,
      'busybox', 'chown', `${uid}:${gid}`, `/out/${fileName}`,
    ], 60_000);
    if (c.exitCode !== 0) throw new Error(`chown of ${fileName} failed (${c.exitCode}): ${c.stderr}`);
  }
}

/** Archive member as a relative path. `./foo/` and `foo` are the same member. */
export function normalizeArchivePath(raw: string): string {
  return raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

function volumeRelative(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '/dst') return '';
  const withoutMount = trimmed.startsWith('/dst/') ? trimmed.slice('/dst/'.length) : trimmed;
  return normalizeArchivePath(withoutMount);
}

/**
 * Paths present on the volume that the archive does not contain, and that are
 * not ancestors of a member. `tar xf` overlays; it does not delete these, so a
 * rollback would keep files the new pin wrote. Deepest first, so a parent
 * removal does not have to cover a child the caller also names.
 */
export function pathsAbsentFromArchive(
  existing: readonly string[], members: readonly string[],
): string[] {
  const keep = new Set<string>();
  for (const raw of members) {
    const member = normalizeArchivePath(raw);
    if (!member || member === '.' || member.split('/').includes('..')) continue;
    keep.add(member);
    const parts = member.split('/');
    for (let i = 1; i < parts.length; i += 1) keep.add(parts.slice(0, i).join('/'));
  }
  const absent = new Set<string>();
  for (const raw of existing) {
    const path = volumeRelative(raw);
    if (!path || path === '.' || path.split('/').includes('..')) continue;
    if (!keep.has(path)) absent.add(path);
  }
  return [...absent].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

export async function untarFileIntoVolume(
  runner: Runner, volume: string, inDir: string, fileName: string,
): Promise<void> {
  const listed = await runner.run([
    'docker', 'run', '--rm', '-v', `${inDir}:/in:ro`,
    'busybox', 'tar', '-tf', `/in/${fileName}`,
  ], 900_000);
  if (listed.exitCode !== 0) {
    throw new Error(`tar list of ${fileName} failed (${listed.exitCode}): ${listed.stderr}`);
  }
  const found = await runner.run([
    'docker', 'run', '--rm', '-v', `${volume}:/dst:ro`,
    'busybox', 'find', '/dst', '-mindepth', '1', '-print',
  ], 900_000);
  if (found.exitCode !== 0) {
    throw new Error(`volume list of ${volume} failed (${found.exitCode}): ${found.stderr}`);
  }
  const absent = pathsAbsentFromArchive(
    found.stdout.split('\n'),
    listed.stdout.split('\n'),
  );
  // busybox rm takes the paths as argv, not a shell string. Batch under the
  // typical ARG_MAX so a volume the new pin filled still deletes.
  for (let i = 0; i < absent.length; i += 100) {
    const batch = absent.slice(i, i + 100).map((path) => `/dst/${path}`);
    const removed = await runner.run([
      'docker', 'run', '--rm', '-v', `${volume}:/dst`,
      'busybox', 'rm', '-rf', ...batch,
    ], 900_000);
    if (removed.exitCode !== 0) {
      throw new Error(`removing paths absent from ${fileName} failed (${removed.exitCode}): ${removed.stderr}`);
    }
  }
  const r = await runner.run([
    'docker', 'run', '--rm',
    '-v', `${volume}:/dst`, '-v', `${inDir}:/in:ro`,
    'busybox', 'tar', 'xf', `/in/${fileName}`, '-C', '/dst',
  ], 900_000);
  if (r.exitCode !== 0) throw new Error(`untar into ${volume} failed (${r.exitCode}): ${r.stderr}`);
}

export interface SnapshotDriver {
  id: string;
  /** The production artifact list, with zero I/O — used by `plan`'s dry run. */
  describe(): { name: string }[];
  take(ctx: SnapshotContext, runner?: Runner): Promise<SnapshotManifest>;
  restore(ctx: SnapshotContext, manifest: SnapshotManifest, runner?: Runner): Promise<void>;
  verify(manifest: SnapshotManifest, dir?: string): Promise<boolean>;
}

/**
 * The default driver. Shells docker with argv arrays through throwaway
 * containers so no service needs to be running (D3) — a ZFS or cloud-disk
 * driver drops in later behind the same `SnapshotDriver` interface without
 * touching `runUpgrade`. That seam is what Slice 5 needs; it is not a
 * license to start a second implementation now (YAGNI applies to drivers,
 * never to the interface).
 */
export const dockerVolumeDriver: SnapshotDriver = {
  id: 'docker-volume',

  describe(): { name: string }[] {
    return [
      ...SNAPSHOT_DATABASES.map((db) => ({ name: artifactNameForDb(db) })),
      ...snapshotVolumes().map((v) => ({ name: artifactNameForVolume(v) })),
    ];
  },

  async take(ctx: SnapshotContext, runner: Runner = defaultRunner): Promise<SnapshotManifest> {
    await mkdir(ctx.outDir, { recursive: true });
    const compose = ctx.compose ?? DEFAULT_COMPOSE;
    // Task 4's `buildManifest` computes bytes + sha256 itself and stores the
    // artifact basename (the manifest is portable), so the driver hands it the
    // live absolute path and nothing else.
    const artifacts: Array<{ name: string; path: string }> = [];

    for (const db of ctx.databases) {
      const name = artifactNameForDb(db);
      const path = join(ctx.outDir, `${sanitize(name)}.sql`);
      await dumpDatabase(runner, compose, db, path);
      artifacts.push({ name, path });
    }
    for (const volume of ctx.volumes) {
      const name = artifactNameForVolume(volume);
      const fileName = `${sanitize(name)}.tar`;
      await tarVolumeToFile(runner, volume, ctx.outDir, fileName);
      artifacts.push({ name, path: join(ctx.outDir, fileName) });
    }

    const manifest = await buildManifest({
      id: randomUUID(),
      runId: ctx.runId,
      fromVersion: process.env.GBRAIN_VERSION ?? '0.50.0.0',
      driver: 'docker-volume',
      artifacts,
      // Placeholder only: `SnapshotManifest.quiesce` is non-nullable (Task 4),
      // so the driver records the empty shape and Task 11's
      // RunDeps.snapshot(ctx, drain) merges the real quiesce evidence in after
      // take() returns. This driver only knows the artifacts it captured, not
      // why the stack was quiet when it captured them.
      quiesce: { stoppedServices: [], drainProofs: {} },
    });
    await writeFile(join(ctx.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  },

  async restore(
    ctx: SnapshotContext, manifest: SnapshotManifest, runner: Runner = defaultRunner,
  ): Promise<void> {
    // Artifact `path` is a basename (Task 4), so verification and restore both
    // resolve it against the snapshot directory the driver wrote it into.
    const { ok, mismatches } = await verifyManifest(manifest, ctx.outDir);
    if (!ok) {
      throw new Error(
        `refusing to restore manifest ${manifest.id}: verification failed for [${mismatches.join(', ')}] ` +
        '(honesty rule 10 — a snapshot nobody can verify is not a backup).',
      );
    }
    const compose = ctx.compose ?? DEFAULT_COMPOSE;
    const byName = new Map(manifest.artifacts.map((a) => [a.name, a]));

    for (const db of ctx.databases) {
      const artifact = byName.get(artifactNameForDb(db));
      if (!artifact) throw new Error(`manifest ${manifest.id} has no artifact for database '${db}'`);
      await restoreDatabase(runner, compose, db, join(ctx.outDir, artifact.path));
    }
    for (const volume of ctx.volumes) {
      const artifact = byName.get(artifactNameForVolume(volume));
      if (!artifact) throw new Error(`manifest ${manifest.id} has no artifact for volume '${volume}'`);
      await untarFileIntoVolume(runner, volume, ctx.outDir, artifact.path);
    }
  },

  async verify(manifest: SnapshotManifest, dir?: string): Promise<boolean> {
    return (await verifyManifest(manifest, dir)).ok;
  },
};
