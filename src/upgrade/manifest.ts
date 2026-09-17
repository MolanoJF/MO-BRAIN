import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SnapshotArtifact, SnapshotManifest } from './types.ts';

export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export type BuildManifestInput = {
  id: string;
  runId: string;
  fromVersion: string;
  driver: string;
  /** `path` is where the artifact lives RIGHT NOW, on the machine building
   * the manifest — only the basename is stored, so the manifest is portable
   * to wherever the snapshot directory is restored. */
  artifacts: Array<{ name: string; path: string }>;
  quiesce: SnapshotManifest['quiesce'];
};

/** Honesty rule 10: a manifest that names an artifact it never hashed is
 * worse than no manifest — it looks like a verified backup and is not. */
export async function buildManifest(input: BuildManifestInput): Promise<SnapshotManifest> {
  const artifacts: SnapshotArtifact[] = [];
  for (const a of input.artifacts) {
    let bytes: number;
    try {
      bytes = (await stat(a.path)).size;
    } catch {
      throw new Error(`buildManifest: artifact "${a.name}" is missing at ${a.path}`);
    }
    artifacts.push({ name: a.name, path: basename(a.path), bytes, sha256: await sha256File(a.path) });
  }
  return {
    id: input.id, runId: input.runId, takenAt: new Date().toISOString(),
    fromVersion: input.fromVersion, driver: input.driver, artifacts, quiesce: input.quiesce,
  };
}

/** The checksum half of honesty rule 10 — Gate C exercises the restore half.
 * `dir` defaults to the current working directory; callers that know the
 * snapshot directory pass it explicitly. `SnapshotManifest` stores only
 * artifact basenames, so there is no directory recorded on the manifest to
 * fall back to. */
export async function verifyManifest(
  manifest: SnapshotManifest, dir: string = process.cwd(),
): Promise<{ ok: boolean; mismatches: string[] }> {
  const mismatches: string[] = [];
  for (const artifact of manifest.artifacts) {
    const path = join(dir, artifact.path);
    let actual: string;
    try {
      actual = await sha256File(path);
    } catch {
      mismatches.push(`${artifact.name}: missing at ${path}`);
      continue;
    }
    if (actual !== artifact.sha256) mismatches.push(`${artifact.name}: sha256 mismatch`);
  }
  return { ok: mismatches.length === 0, mismatches };
}
