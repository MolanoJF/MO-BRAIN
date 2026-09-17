import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../control/db/client.ts';
import { diffCapability } from '../contracts/capability.ts';
import type { CapabilitySnapshot, CapabilityDrift, HarnessAdapter } from '../contracts/capability.ts';

type Db = ReturnType<typeof getDb>;

/**
 * A fresh row every call — never an update, never an upsert.
 * `capability_snapshots.gbrainVersion` carries NO uniqueness constraint
 * (schema.ts:135-142), unlike `playbook_ledger`'s `.unique()`
 * (schema.ts:146): playbook_ledger is CURRENT STATE per version;
 * capability_snapshots is a HISTORY of captures. `capturedAt` plus the
 * existing version index is how a caller reads "the latest one" without
 * ever losing an earlier capture.
 */
export async function recordCapabilitySnapshot(
  db: Db, version: string, snapshot: CapabilitySnapshot,
): Promise<{ id: string }> {
  const id = randomUUID();
  await db.insert(schema.capabilitySnapshots).values({
    id,
    gbrainVersion: version,
    toolsJson: snapshot.tools as any,
    harnesses: (snapshot.wellKnown?.adapters ?? null) as any,
    profiles: (snapshot.wellKnown?.profiles ?? null) as any,
    capturedAt: new Date(snapshot.capturedAt),
  });
  return { id };
}

export async function latestSnapshotFor(db: Db, version: string): Promise<CapabilitySnapshot | null> {
  const rows = await db.select().from(schema.capabilitySnapshots)
    .where(eq(schema.capabilitySnapshots.gbrainVersion, version))
    .orderBy(desc(schema.capabilitySnapshots.capturedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    gbrainVersion: row.gbrainVersion,
    capturedAt: row.capturedAt.toISOString(),
    tools: row.toolsJson,
    wellKnown: { profiles: row.profiles ?? null, adapters: (row.harnesses as HarnessAdapter[] | null) ?? [] },
    // Not persisted here — the table has no schemaPacks column, and
    // diffCapability never reads it. The full snapshot (schemaPacks
    // included) still lands in contracts/v<version>/capability.json
    // (scripts/capture-capability.ts); this row exists for the drift
    // primitive only, never as a second copy of that file.
    schemaPacks: null,
  };
}

/**
 * Thrown, never returned, so a caller cannot conflate "nothing to compare"
 * with "no drift" by forgetting to check a flag — the trap this whole
 * function exists to close.
 */
export class SingleSnapshotError extends Error {
  constructor(public readonly available: string[]) {
    super(
      `capability drift needs a recorded snapshot at BOTH versions; only ` +
      `${available.length ? available.join(', ') : 'neither'} ` +
      `${available.length === 1 ? 'has' : 'have'} one`,
    );
    this.name = 'SingleSnapshotError';
  }
}

/**
 * Resolves to EXACTLY `diffCapability`'s own shape — nothing wraps it, so a
 * caller cannot forget to unwrap a `{comparable}` envelope and silently
 * compare against `undefined`. Callable with or without an explicit `db`
 * (Gate C, Task 17, calls the two-argument form).
 */
export async function driftBetween(fromVersion: string, toVersion: string): Promise<CapabilityDrift>;
export async function driftBetween(db: Db, fromVersion: string, toVersion: string): Promise<CapabilityDrift>;
export async function driftBetween(a: Db | string, b: string, c?: string): Promise<CapabilityDrift> {
  const [db, fromVersion, toVersion] = typeof a === 'string' ? [getDb(), a, b] : [a, b, c!];
  const [before, after] = await Promise.all([
    latestSnapshotFor(db, fromVersion), latestSnapshotFor(db, toVersion),
  ]);
  if (!before || !after) {
    const available = [before ? fromVersion : null, after ? toVersion : null]
      .filter((v): v is string => v !== null);
    throw new SingleSnapshotError(available);
  }
  return diffCapability(before, after);
}
