import { rename, writeFile, readFile, mkdir, chmod, unlink, rm, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { SQL } from 'bun';
import { withAdvisoryLock } from './lock.ts';
import { BUNDLED_PACKS, MANAGED_PACKS, isManagedPack } from '../contracts/packs.ts';

const GBRAIN_HOME = process.env.GBRAIN_HOME ?? '/srv/gbrain-home';
// gbrain's configDir() always appends `.gbrain` under GBRAIN_HOME
// (`GBRAIN_HOME=/srv/x` → `/srv/x/.gbrain/config.json`). Match that exactly
// or patchFilePlaneConfig writes a file init/embed never read.
export const CONFIG_PATH = join(GBRAIN_HOME, '.gbrain', 'config.json');
export const SCHEMA_PACK_DIR = join(GBRAIN_HOME, '.gbrain', 'schema-packs');

/** Same shape the wizard enforces — lowercase, digits, hyphens; no path separators. */
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CREDS_NAME = /^\.creds-[A-Za-z0-9._-]+\.json$/;

/**
 * Read-then-delete a single `.creds-*.json` under GBRAIN_HOME. Path must
 * resolve inside the home root — no traversal, no subdirectories, no
 * passthrough cat of arbitrary files (S2).
 */
export async function takeGrantCredentialsFile(requested: unknown): Promise<unknown> {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new Error('path required');
  }
  if (requested.includes('\0') || requested.includes('..')) {
    throw new Error('invalid path');
  }
  const home = resolve(process.env.GBRAIN_HOME ?? '/srv/gbrain-home');
  const resolved = resolve(requested);
  const rel = relative(home, resolved);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.length === 0) {
    throw new Error('path not under GBRAIN_HOME');
  }
  if (dirname(resolved) !== home) {
    throw new Error('path not under GBRAIN_HOME');
  }
  const name = basename(resolved);
  if (!CREDS_NAME.test(name)) {
    throw new Error('invalid credentials file');
  }
  const raw = await readFile(resolved, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('credentials file was not json');
  }
  await unlink(resolved);
  return parsed;
}

/** gbrain's own guard for a delivery client id (`core/harness/delivery.ts`). */
const DELIVERY_CLIENT_RE = /^gbrain_cl_[A-Za-z0-9_-]+$/;

/**
 * Delete the private credential journal `mcp grant` left for a client we have
 * just revoked: `<configDir>/credential-deliveries/<client_id>.json`, written
 * before the grant committed (`core/harness/delivery.ts`). Revoking the client
 * does NOT remove it (F7, re-measured: the file survives `revoke-client`), so
 * after a revoke the journal is the last copy of a dead secret on the file
 * plane. Deleting it is the only thing that closes that window.
 *
 * The path is COMPUTED here from a validated client id — the request carries no
 * path at all, so there is no traversal surface (same shape as
 * `readSupervisorAuditTail`, and unlike `takeGrantCredentialsFile`, which must
 * accept a path because gbrain chose where to write it).
 */
export async function deleteCredentialDelivery(clientId: unknown): Promise<{ deleted: boolean }> {
  if (typeof clientId !== 'string' || !DELIVERY_CLIENT_RE.test(clientId)) {
    throw new Error('invalid client id');
  }
  try {
    await unlink(join(GBRAIN_HOME, '.gbrain', 'credential-deliveries', `${clientId}.json`));
    return { deleted: true };
  } catch (e) {
    // Absent is the normal case for a client whose journal was never written
    // (or already deleted) — not an error, and never a reason to fail a revoke.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { deleted: false };
    throw e;
  }
}

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

const AUDIT_DIR = process.env.GBRAIN_AUDIT_DIR ?? join(GBRAIN_HOME, '.gbrain', 'audit');

/** ISO-8601 week file name, matching gbrain's own `supervisor-YYYY-Www.jsonl`
 *  naming (RECON, U9). */
function isoWeekAuditFile(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `supervisor-${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}.jsonl`;
}

/**
 * Tail the CURRENT ISO week's supervisor audit log. A read, not a write —
 * S3 gates file-plane WRITES behind the advisory lock; this takes none. The
 * path is computed here, never accepted from the caller — no traversal
 * surface at all, unlike `takeGrantCredentialsFile`.
 */
export async function readSupervisorAuditTail(lines: number): Promise<string[]> {
  const path = join(AUDIT_DIR, isoWeekAuditFile(new Date()));
  const raw = await readIfExists(path);
  if (raw === null) return [];
  return raw.split('\n').filter((l) => l.trim() !== '').slice(-Math.max(1, lines));
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

/**
 * Absolute path of a user pack's manifest.
 *
 * gbrain discovers a user pack ONLY as a directory named after the pack with
 * `pack.yaml` / `pack.yml` / `pack.json` inside it (`defaultPackLocator`,
 * src/core/schema-pack/load-active.ts; `runList` enumerates subdirectories the
 * same way). MEASURED against the pinned 0.50.5.0 container: a flat
 * `<name>.yaml` written here is invisible to `schema list` and answers
 * `Pack not found: <name>` from `schema lint`. See
 * docs/archive/schema-pack-findings.md S1.
 */
export function packPath(name: string): string {
  return join(SCHEMA_PACK_DIR, name, 'pack.yaml');
}

/** Write a user schema pack manifest. 0644: gbrain reads it as another user. */
export async function writeSchemaPack(name: string, yaml: string, opts: { sql: SQL }): Promise<void> {
  assertUserPackName(name);
  await writeFilePlane(packPath(name), () => yaml, { ...opts, mode: 0o644 });
  // The loader takes the first existing of pack.yaml / pack.yml / pack.json
  // (load-active.ts; MEASURED docs/archive/schema-pack-findings.md S7 step 4), so a
  // stale pack.json would shadow this YAML write. Delete the sibling.
  await unlink(join(SCHEMA_PACK_DIR, name, 'pack.json'))
    .catch((e) => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
}

const BUNDLED = new Set<string>(BUNDLED_PACKS);
const PACK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertUserPackName(name: string): void {
  if (!PACK_NAME_RE.test(name)) throw new Error(`invalid schema pack name: ${name}`);
  if (BUNDLED.has(name)) throw new Error(`${name} is a bundled pack and cannot be written`);
  if (isManagedPack(name)) throw new Error(`${name} is a Mo-brain-managed pack and cannot be written`);
}

/**
 * A created pack is written as pack.json: gbrain's `schema fork` writes the
 * same format, gbrain's mutations preserve it, and the control plane has no
 * YAML serializer at runtime. Any pack.yaml / pack.yml sibling is removed,
 * because the loader's precedence between two formats is exactly the kind of
 * silent ambiguity S7 step 4 measured.
 */
export async function writeSchemaPackJson(name: string, manifest: unknown, opts: { sql: SQL }): Promise<void> {
  assertUserPackName(name);
  const dir = join(SCHEMA_PACK_DIR, name);
  await writeFilePlane(join(dir, 'pack.json'), () => JSON.stringify(manifest, null, 2) + '\n', { ...opts, mode: 0o644 });
  for (const sibling of ['pack.yaml', 'pack.yml']) {
    await unlink(join(dir, sibling)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }
}

/**
 * A user pack's manifest exactly as stored, with its format, so a failed
 * write can be put back byte-for-byte in the format it was read.
 */
export async function readSchemaPackRaw(name: string): Promise<{ format: 'json' | 'yaml'; text: string } | null> {
  assertUserPackName(name);
  const dir = join(SCHEMA_PACK_DIR, name);
  for (const [file, format] of [['pack.yaml', 'yaml'], ['pack.yml', 'yaml'], ['pack.json', 'json']] as const) {
    const text = await readFile(join(dir, file), 'utf8').catch(() => null);
    if (text !== null) return { format, text };
  }
  return null;
}

/** Delete one user pack's directory. The path is computed, never accepted. */
export async function removeSchemaPack(name: string, opts: { sql: SQL }): Promise<{ removed: boolean }> {
  assertUserPackName(name);
  const dir = join(SCHEMA_PACK_DIR, name);
  return withAdvisoryLock(opts.sql, `fileplane:${dir}`, async () => {
    const existed = await readdir(dir).then(() => true, () => false);
    await rm(dir, { recursive: true, force: true });
    return { removed: existed };
  });
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
        '-c', 'user.email=mobrain@localhost',
        '-c', 'user.name=mobrain',
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

/**
 * Mo-brain's shipped packs (spec §4.2). Written at ops boot, before any
 * `gbrain init` can name them, and rewritten only when the shipped version
 * moves, so a restart never churns the file plane. Bypasses
 * assertUserPackName on purpose: this is the only writer of managed names.
 */
export async function seedManagedPacks(
  opts: { sql: SQL; sourceDir?: string },
): Promise<{ name: string; action: 'written' | 'unchanged' }[]> {
  const sourceDir = opts.sourceDir ?? join(import.meta.dir, 'packs');
  const out: { name: string; action: 'written' | 'unchanged' }[] = [];
  for (const name of MANAGED_PACKS) {
    const shipped = JSON.parse(await readFile(join(sourceDir, `${name}.json`), 'utf8')) as { version?: string };
    const dest = join(SCHEMA_PACK_DIR, name, 'pack.json');
    const current = await readFile(dest, 'utf8')
      .then((t) => (JSON.parse(t) as { version?: string }).version ?? null)
      .catch(() => null);
    if (current === shipped.version) { out.push({ name, action: 'unchanged' }); continue; }
    await writeFilePlane(dest, () => JSON.stringify(shipped, null, 2) + '\n', { ...opts, mode: 0o644 });
    for (const sibling of ['pack.yaml', 'pack.yml']) {
      await unlink(join(SCHEMA_PACK_DIR, name, sibling)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    }
    out.push({ name, action: 'written' });
  }
  return out;
}
