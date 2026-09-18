import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, pinDb, runMigrations, schema } from '../../src/control/db/client.ts';
import {
  recordCapabilitySnapshot, latestSnapshotFor, driftBetween, SingleSnapshotError,
} from '../../src/upgrade/capability.ts';
import type { CapabilitySnapshot } from '../../src/contracts/capability.ts';

process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

// Scoped to THIS file's own fixture. `capability_snapshots` is keyed by version
// text with no owner column, and other files in this directory legitimately
// write the SAME versions: agent-runs.test.ts seeds the running pin's catalog
// (0.50.5.0) so D5 has a tool surface to read, and this suite's afterAll used to
// delete precisely that row. Under `bun test test/integration` (files run
// concurrently) the shared pair made "only one version recorded" depend on
// another file's timing — and it stopped being true at all once agent-runs
// seeded 0.50.5.0 between the FROM insert and the driftBetween call. A per-run
// suffix gives this suite a private pair, so the premise is a property of its
// own rows. Nothing about the delta under test changes: driftBetween compares
// version strings (diffCapability: `before.gbrainVersion !== after.gbrainVersion`)
// and reads every other field off the rows, never off the version labels.
const RUN = randomUUID().slice(0, 8);
const FROM = `0.50.0.0-${RUN}`;
const TO = `0.50.5.0-${RUN}`;

function snap(version: string, tools: string[]): CapabilitySnapshot {
  return {
    gbrainVersion: version,
    capturedAt: new Date().toISOString(),
    tools: tools.map((name) => ({ name })),
    wellKnown: {
      profiles: { default: 'memory-writer' },
      adapters: [{ id: 'claude-code', label: 'Claude Code', connection: 'stdio', modes: ['read'] }],
    },
    schemaPacks: { bundled: ['gbrain-base'], raw: '' },
  };
}

beforeAll(async () => { pinDb(); await runMigrations(); });
afterAll(async () => {
  // Only this suite's own suffixed pair — see RUN above. Deleting the bare
  // 0.50.0.0/0.50.5.0 rows here is what corrupted a sibling's fixture.
  await getDb().delete(schema.capabilitySnapshots).where(eq(schema.capabilitySnapshots.gbrainVersion, FROM));
  await getDb().delete(schema.capabilitySnapshots).where(eq(schema.capabilitySnapshots.gbrainVersion, TO));
  await closeDb();
});

describe('capability snapshots and drift', () => {
  test('with only one version recorded, driftBetween refuses rather than saying "no drift"', async () => {
    await recordCapabilitySnapshot(getDb(), FROM, snap(FROM, ['search', 'whoami']));
    // The plan also wrote `await expect(driftBetween(...)).rejects
    // .toBeInstanceOf(SingleSnapshotError)` here, but in this bun version an
    // `expect(promise).rejects` assertion that follows a DB insert in the SAME
    // test never settles and the test times out — while the identical
    // assertion via try/catch completes. The try/catch below asserts exactly
    // the same thing (instance + `available`), so no coverage is lost.
    try {
      await driftBetween(getDb(), FROM, TO);
      throw new Error('unreachable: the line above must throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SingleSnapshotError);
      expect((e as SingleSnapshotError).available).toEqual([FROM]);
    }
  });

  // U10: this delta ships zero capability drift. The assertion that matters
  // is that driftBetween reports EXACTLY versionChanged and nothing else —
  // a non-empty toolsAdded/toolsRemoved here would be a finding to record,
  // never a number to silently adjust.
  test('two identical-catalog snapshots at different versions report versionChanged and nothing else', async () => {
    await recordCapabilitySnapshot(getDb(), TO, snap(TO, ['search', 'whoami']));
    const drift = await driftBetween(getDb(), FROM, TO);
    expect(drift).toEqual({
      versionChanged: true, toolsAdded: [], toolsRemoved: [],
      adaptersAdded: [], adaptersRemoved: [], profilesChanged: false,
    });
    // The two-argument overload — no db — the shape Gate C's own C10 calls.
    expect(await driftBetween(FROM, TO)).toEqual(drift);
  });

  test('a second capture at the SAME version appends — it does not overwrite the first', async () => {
    await recordCapabilitySnapshot(getDb(), FROM, snap(FROM, ['search', 'whoami', 'dream']));
    const rows = await getDb().select().from(schema.capabilitySnapshots)
      .where(eq(schema.capabilitySnapshots.gbrainVersion, FROM));
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // latestSnapshotFor reads the newest one, not the first.
    const latest = await latestSnapshotFor(getDb(), FROM);
    expect((latest!.tools as { name: string }[]).map((t) => t.name)).toContain('dream');
  });
});
