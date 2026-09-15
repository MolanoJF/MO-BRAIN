import { rename, writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SQL } from 'bun';
import { withAdvisoryLock, mergeConfigJson } from './lock.ts';

const GBRAIN_HOME = process.env.GBRAIN_HOME ?? '/srv/gbrain-home';
export const CONFIG_PATH = join(GBRAIN_HOME, 'config.json');
export const SCHEMA_PACK_DIR = join(GBRAIN_HOME, 'schema-packs');

/** Atomic write: temp file in the same directory, fsync, rename. */
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
