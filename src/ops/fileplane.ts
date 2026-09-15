import { rename, writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { SQL } from 'bun';
import { withAdvisoryLock } from './lock.ts';

const GBRAIN_HOME = process.env.GBRAIN_HOME ?? '/srv/gbrain-home';
// gbrain's configDir() always appends `.gbrain` under GBRAIN_HOME
// (`GBRAIN_HOME=/srv/x` → `/srv/x/.gbrain/config.json`). Match that exactly
// or patchFilePlaneConfig writes a file init/embed never read.
export const CONFIG_PATH = join(GBRAIN_HOME, '.gbrain', 'config.json');
export const SCHEMA_PACK_DIR = join(GBRAIN_HOME, '.gbrain', 'schema-packs');

/** Same shape the wizard enforces — lowercase, digits, hyphens; no path separators. */
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function reposRoot(): string {
  return process.env.BRAIN_REPOS ?? '/srv/brain-repos';
}

/** Spawn git with an argv array only — never a shell string (S2). */
function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

/**
 * Atomic write: write a temp file in the same directory, then rename it over
 * the target. `rename` within one directory (same filesystem) is atomic, so
 * a reader never observes a torn or partial file — that is what S3 actually
 * requires. This does not fsync: durability across a host power loss is a
 * stronger guarantee S3 does not ask for here. `config.json` is a rewritable
 * projection, not the durable source of truth for secrets — that will be the
 * envelope-encrypted control DB arriving in Task 6.
 */
async function atomicWrite(path: string, contents: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contents, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

async function readIfExists(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

/**
 * Merge a patch into config.json. Never blind-writes: an unparseable document
 * is a signal something else is mid-write or corrupt, and overwriting it is
 * exactly the API-key-eating failure S3 exists to prevent.
 */
export function mergeConfigJson(current: string | null, patch: Record<string, unknown>): string {
  let base: Record<string, unknown> = {};
  if (current !== null && current.trim() !== '') {
    try {
      base = JSON.parse(current) as Record<string, unknown>;
    } catch {
      throw new Error('refusing to overwrite unparseable config.json');
    }
  }
  return JSON.stringify({ ...base, ...patch }, null, 2) + '\n';
}

/**
 * The single serialized writer for the file plane (S3). Every mutation —
 * wizard, init, post-upgrade — goes through here, under one advisory lock in
 * the CONTROL database.
 */
export async function writeFilePlane(
  path: string,
  mutate: (current: string | null) => string,
  opts: { sql: SQL; mode?: number },
): Promise<void> {
  await withAdvisoryLock(opts.sql, `fileplane:${path}`, async () => {
    const current = await readIfExists(path);
    await atomicWrite(path, mutate(current), opts.mode ?? 0o600);
  });
}

/** Patch config.json — the only place a provider API key is written (V11). */
export async function patchConfig(patch: Record<string, unknown>, opts: { sql: SQL }): Promise<void> {
  await writeFilePlane(CONFIG_PATH, (current) => mergeConfigJson(current, patch), opts);
}

/** Write a user schema pack YAML. 0644: gbrain reads it as another user. */
export async function writeSchemaPack(name: string, yaml: string, opts: { sql: SQL }): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`invalid schema pack name: ${name}`);
  await writeFilePlane(join(SCHEMA_PACK_DIR, `${name}.yaml`), () => yaml, { ...opts, mode: 0o644 });
}

/**
 * Create a git repo under the brain-repos root with at least one committed,
 * tracked file so `gbrain sources add --path` will accept it (V12). Serialized
 * under the same advisory-lock family as other file-plane writes (S3).
 */
export async function seedSpaceRepo(sourceId: string, opts: { sql: SQL }): Promise<string> {
  if (!SOURCE_ID_RE.test(sourceId)) {
    throw new Error(`invalid sourceId: ${sourceId}`);
  }
  const dir = join(reposRoot(), sourceId);
  await withAdvisoryLock(opts.sql, `fileplane:seed-space:${sourceId}`, async () => {
    await mkdir(dir, { recursive: true });
    await runGit(dir, ['init']);
    await writeFile(join(dir, 'README.md'), `# ${sourceId}\n`, 'utf8');
    await runGit(dir, ['add', '-A']);
    // Identity via -c flags in argv — never `git config` global, never a shell.
    try {
      await runGit(dir, [
        '-c', 'user.email=brainstand@localhost',
        '-c', 'user.name=brainstand',
        'commit', '-m', 'seed',
      ]);
    } catch (e) {
      // Idempotent retry: already seeded (nothing to commit) is success if HEAD exists.
      try {
        await runGit(dir, ['rev-parse', 'HEAD']);
      } catch {
        throw e;
      }
    }
  });
  return dir;
}
