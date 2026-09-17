/**
 * Journal → control DB. The control plane is stopped for most of an upgrade
 * (D3's quiesce order stops it third), so it cannot be the run's system of
 * record while it is down. scripts/upgrade.ts — a HOST process (D1) that
 * holds no control-DB connection at all — journals every transition to
 * `<UPGRADE_DIR>/<runId>/journal.ndjson`, one JSON event per line, seq
 * monotonic per run. This file replays that journal into upgrade_runs /
 * upgrade_events / playbook_ledger / upgrade_checklist_items, on boot and on
 * a timer (src/control/app.ts), idempotent on the UNIQUE (runId, seq) Task 3
 * put on upgrade_events.
 *
 * JOURNAL SHAPE (deviation note, reported): the plan's Task 13 sample reads
 * `event.type`, but Task 3's canonical `upgrade_events` table has a `step`
 * column and no `type`, and Task 4/11's canonical `appendEvent` writes
 * `{ seq, at, step, level, message, data }`. So the reconciler normalizes BOTH
 * on-disk shapes into one internal `{ type, data }`:
 *   - a TYPED line `{ seq, at, type, data }` (the integration test's journal),
 *   - a STEP line `{ seq, at, step: <run state>, message, data }` (what
 *     scripts/upgrade.ts writes), where `step` names the state.
 * The event type then lands in the `step` column.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../control/db/client.ts';
import { UPGRADE_RUN_STATES, type UpgradeRunState } from './types.ts';
import { canTransition } from './state.ts';
import {
  PLAYBOOK_STATES, openChecklist, recordPlaybook,
  type OpenChecklistItem, type PlaybookState,
} from './ledger.ts';
import { recordCapabilitySnapshot } from './capability.ts';
import type { CapabilitySnapshot } from '../contracts/capability.ts';

type Db = ReturnType<typeof getDb>;

/**
 * A boot reconcile catches everything that happened while the control plane
 * was down — most of any upgrade. The timer catches what lands while it is
 * back up: a rollback run (`scripts/upgrade.ts rollback`) can happen with the
 * control plane already serving traffic, and a checklist item opened mid-run
 * should not wait for the next restart. 60s is frequent enough that an admin
 * sees a rollback's checklist inside a minute; upgrade_events is a handful of
 * rows per run, so polling that often costs nothing worth measuring.
 */
export const UPGRADE_RECONCILE_INTERVAL_MS = 60_000;

export type ReconcileSummary = {
  runsScanned: number;
  eventsImported: number;
  eventsSkipped: number;
  truncatedRuns: string[];
};

type NormalizedEvent = {
  runId: string;
  seq: number;
  at: string;
  type: string;
  message: string;
  data: Record<string, unknown>;
};

/**
 * Turn one parsed journal line into the internal event. Throws on a line that
 * is structurally committed-but-unreadable (no seq, or neither type nor step):
 * that is corruption, not a race, and the caller decides whether it was the
 * trailing line.
 */
function normalize(runId: string, raw: Record<string, unknown>): NormalizedEvent {
  const seq = raw.seq;
  if (typeof seq !== 'number' || !Number.isFinite(seq)) {
    throw new Error(`upgrade journal ${runId} has an event without a numeric seq`);
  }
  const at = typeof raw.at === 'string' ? raw.at : new Date().toISOString();
  const message = typeof raw.message === 'string' ? raw.message : '';
  const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)
    ? raw.data as Record<string, unknown> : {};

  if (typeof raw.type === 'string' && raw.type !== '') {
    return { runId, seq, at, type: raw.type, message, data };
  }

  const step = typeof raw.step === 'string' && raw.step !== '' ? raw.step : null;
  if (!step) throw new Error(`upgrade journal ${runId} event ${seq} has neither type nor step`);

  if ((UPGRADE_RUN_STATES as readonly string[]).includes(step)) {
    if (step === 'planned') {
      // The host CLI's opening event, before any run row exists. Derive the
      // version pair from structured data, or from the CLI's own
      // `"<from> -> <to>"` message (our format, not gbrain prose).
      const parsed = /\b(\d+\.\d+\.\d+\.\d+)\s*->\s*(\d+\.\d+\.\d+\.\d+)\b/.exec(message);
      const fromVersion = typeof data.fromVersion === 'string' ? data.fromVersion : parsed?.[1];
      const toVersion = typeof data.toVersion === 'string' ? data.toVersion : parsed?.[2];
      return {
        runId, seq, at, type: 'run_started', message,
        data: {
          fromVersion: fromVersion ?? '',
          toVersion: toVersion ?? '',
          createdBy: typeof data.createdBy === 'string' ? data.createdBy : 'operator',
        },
      };
    }
    const type = step === 'playbooks_applied' ? 'playbooks_applied' : 'state_changed';
    return { runId, seq, at, type, message, data: { ...data, to: step } };
  }

  // A step that names an event type rather than a run state.
  return { runId, seq, at, type: step, message, data };
}

/**
 * Read one run's journal, tolerating a partial trailing write. NDJSON
 * written by a live host process can be read mid-append: every COMPLETE
 * line parses and imports; an incomplete tail is dropped and reported, never
 * thrown — the next pass (this timer, or the next boot) picks it up once the
 * writer finishes the line. A corrupt line that is NOT the last one is a
 * real bug, not a race, so it still throws.
 */
async function readRunJournal(dir: string, runId: string): Promise<{ events: NormalizedEvent[]; truncated: boolean }> {
  const path = join(dir, runId, 'journal.ndjson');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], truncated: false };
    throw e;
  }
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const events: NormalizedEvent[] = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (i === lines.length - 1) { truncated = true; continue; }
      throw new Error(`upgrade journal ${runId} is corrupt at a non-trailing line`);
    }
    events.push(normalize(runId, parsed));
  }
  events.sort((a, b) => a.seq - b.seq);
  return { events, truncated };
}

export async function reconcileJournals(db: Db, dir: string): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { runsScanned: 0, eventsImported: 0, eventsSkipped: 0, truncatedRuns: [] };

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return summary; // no upgrade has ever run
    throw e;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    summary.runsScanned += 1;
    const { events, truncated } = await readRunJournal(dir, runId);
    if (truncated) summary.truncatedRuns.push(runId);
    for (const event of events) {
      if (await importEvent(db, event, dir)) summary.eventsImported += 1;
      else summary.eventsSkipped += 1;
    }
  }
  return summary;
}

async function importEvent(db: Db, event: NormalizedEvent, dir: string): Promise<boolean> {
  // `upgrade_events.run_id` is a FOREIGN KEY to `upgrade_runs.id` (Task 3), so
  // the run row has to exist before its `run_started` event can be inserted —
  // the effect cannot wait until after the row insert like the others do. This
  // is idempotent on the run id, so a re-import is still a no-op.
  if (event.type === 'run_started') await ensureRun(db, event);

  // UNIQUE (runId, seq) — Task 3 — IS the idempotency mechanism: a re-import
  // of an already-seen event inserts nothing, and its side effect (below)
  // never runs a second time.
  const inserted = await db.insert(schema.upgradeEvents)
    .values({
      id: randomUUID(), runId: event.runId, seq: event.seq,
      at: new Date(event.at), step: event.type, level: 'info',
      message: event.message, data: event.data as object,
    })
    .onConflictDoNothing({ target: [schema.upgradeEvents.runId, schema.upgradeEvents.seq] })
    .returning({ id: schema.upgradeEvents.id });
  if (inserted.length === 0) return false;

  await applyEffects(db, event, dir);
  return true;
}

async function ensureRun(db: Db, event: NormalizedEvent): Promise<void> {
  const data = event.data as { fromVersion?: string; toVersion?: string; createdBy?: string };
  await db.insert(schema.upgradeRuns).values({
    id: event.runId, fromVersion: data.fromVersion ?? '', toVersion: data.toVersion ?? '',
    state: 'planned', startedAt: new Date(event.at), createdBy: data.createdBy ?? null,
  }).onConflictDoNothing({ target: schema.upgradeRuns.id });
}

async function replayLedgerRow(db: Db, row: Record<string, unknown>): Promise<void> {
  const version = String(row.version ?? row.gbrainVersion ?? '');
  const state = String(row.state ?? '');
  const note = String(row.note ?? row.notes ?? '');
  if (!version) return;
  if (!(PLAYBOOK_STATES as readonly string[]).includes(state)) {
    throw new Error(`playbooks_applied ledger row for ${version} has unknown state '${state}'`);
  }
  await recordPlaybook(db, {
    version, state: state as PlaybookState, note,
    ...(typeof row.decidedBy === 'string' ? { decidedBy: row.decidedBy } : {}),
  });
}

async function applyEffects(db: Db, event: NormalizedEvent, dir: string): Promise<void> {
  switch (event.type) {
    case 'run_started': {
      await ensureRun(db, event);
      return;
    }
    case 'capability': {
      // D2/Task 8 (F7): the host CLI captured this pin's capability into the
      // run directory as data; import it here, exactly once, on the same
      // journal-first path as the ledger and the checklist. `importEvent` only
      // calls applyEffects when the (runId, seq) event row was NEW, so a
      // re-import never appends a duplicate snapshot row.
      const data = event.data as { version?: unknown; file?: string };
      if (typeof data.version !== 'string' || typeof data.file !== 'string') return;
      let snapshot: CapabilitySnapshot;
      try {
        snapshot = JSON.parse(await readFile(join(dir, event.runId, data.file), 'utf8')) as CapabilitySnapshot;
      } catch {
        // The file was not written (a run that died before the capture), or a
        // partial write; a later pass picks it up once the writer finishes.
        return;
      }
      await recordCapabilitySnapshot(db, data.version, snapshot);
      return;
    }
    case 'state_changed': {
      const data = event.data as { to?: UpgradeRunState; snapshotId?: string };
      if (!data.to) return;
      await advanceRunState(db, event.runId, data.to, data.snapshotId);
      return;
    }
    case 'playbooks_applied': {
      // D6/D2: the host CLI holds no control-DB connection, so it cannot
      // call Task 9's ledger functions itself — it journals the payload and
      // THIS is where they finally run, exactly once, against the real DB.
      const data = event.data as {
        ledger?: Array<Record<string, unknown>>;
        checklist?: Array<Record<string, unknown>>;
      };
      for (const row of data.ledger ?? []) await replayLedgerRow(db, row);
      const items: OpenChecklistItem[] = (data.checklist ?? []).map((c) => ({
        key: String(c.key ?? c.itemKey ?? ''),
        version: String(c.version ?? c.gbrainVersion ?? ''),
        prompt: String(c.prompt ?? ''),
        why: String(c.why ?? ''),
      })).filter((i) => i.key !== '');
      if (items.length > 0) await openChecklist(db, event.runId, items);
      await advanceRunState(db, event.runId, 'playbooks_applied');
      return;
    }
    default:
      // Every other event type (quiesce_verified, step_started, step_failed,
      // doctor_compared, ...) is recorded in upgrade_events for the console's
      // timeline and needs no side effect of its own.
      return;
  }
}

/**
 * Never regress. A late or duplicated `state_changed` event naming an
 * earlier state than the run already holds is recorded in upgrade_events —
 * the append-only timeline stays complete and honest — but does not move
 * `upgrade_runs.state` backwards. This is the D2 guarantee the boot
 * reconcile and the timer both share.
 */
async function advanceRunState(db: Db, runId: string, to: UpgradeRunState, snapshotId?: string): Promise<void> {
  const [run] = await db.select({ state: schema.upgradeRuns.state })
    .from(schema.upgradeRuns).where(eq(schema.upgradeRuns.id, runId));
  if (!run) return; // run_started has not landed yet — a later pass catches up
  if (!canTransition(run.state as UpgradeRunState, to)) return;

  const patch: Record<string, unknown> = { state: to };
  if (snapshotId) patch.snapshotId = snapshotId;
  // `upgrade_runs` names this column `ended_at` (Task 3), not `finished_at`.
  if (to === 'completed' || to === 'failed' || to === 'rolled_back') patch.endedAt = new Date();
  await db.update(schema.upgradeRuns).set(patch).where(eq(schema.upgradeRuns.id, runId));
}
