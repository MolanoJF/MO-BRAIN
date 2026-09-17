import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, pinDb, runMigrations, schema } from '../../src/control/db/client.ts';
import {
  ackChecklistItem, ledgerFor, openChecklist, pendingDecisions, recordPlaybook,
} from '../../src/upgrade/ledger.ts';

// L8: defaulted HERE, never required as an export from a helper.
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

const RUN = `run-${randomUUID()}`;
const V = '0.50.2.0';

beforeAll(async () => {
  pinDb();
  await runMigrations();
  // upgrade_checklist_items.run_id has a FK to upgrade_runs (Task 3), and a
  // reconciler only opens a checklist for a run that exists (D2). Seed it.
  await getDb().insert(schema.upgradeRuns).values({
    id: RUN, fromVersion: '0.50.0.0', toVersion: V, createdBy: 'test',
  });
});

afterAll(async () => {
  // Deleting the run cascades its checklist items (Task 3 FK).
  await getDb().delete(schema.upgradeRuns).where(eq(schema.upgradeRuns.id, RUN));
  await getDb().delete(schema.playbookLedger)
    .where(eq(schema.playbookLedger.gbrainVersion, V));
  await closeDb();
});

beforeEach(async () => {
  await getDb().delete(schema.upgradeChecklistItems)
    .where(eq(schema.upgradeChecklistItems.gbrainVersion, V));
  await getDb().delete(schema.playbookLedger)
    .where(eq(schema.playbookLedger.gbrainVersion, V));
});

describe('playbook ledger', () => {
  test('a first write creates the row and names what was applied', async () => {
    await recordPlaybook(getDb(), {
      version: V, state: 'applied',
      note: 'applied 1 deterministic step [assert-starting-version] from skills/migrations/v0.50.2.0.md',
    });
    const row = await ledgerFor(getDb(), V);
    expect(row?.state).toBe('applied');
    expect(row?.notes).toContain('assert-starting-version');
  });

  test('notes are append-only: the row is the install history for that version', async () => {
    await recordPlaybook(getDb(), { version: V, state: 'applied', note: 'first pass' });
    await recordPlaybook(getDb(), { version: V, state: 'pending', note: 'rolled back by run X' });
    const row = await ledgerFor(getDb(), V);
    expect(row?.state).toBe('pending');
    expect(row?.notes).toContain('first pass');
    expect(row?.notes).toContain('rolled back by run X');
    expect(row!.notes!.trim().split('\n')).toHaveLength(2);
  });

  test('gbrain_version is UNIQUE, so a second upgrade updates one row rather than adding one', async () => {
    await recordPlaybook(getDb(), { version: V, state: 'applied', note: 'first upgrade' });
    await recordPlaybook(getDb(), { version: V, state: 'pending', note: 'rolled back' });
    await recordPlaybook(getDb(), { version: V, state: 'applied', note: 'second upgrade' });
    const rows = await getDb().select().from(schema.playbookLedger)
      .where(eq(schema.playbookLedger.gbrainVersion, V));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('applied');
    expect(rows[0]!.notes!.trim().split('\n')).toHaveLength(3);
  });

  test('a decider is never erased by a later write that has none', async () => {
    await recordPlaybook(getDb(), {
      version: V, state: 'awaiting_admin_decision', note: 'opened 1 item', decidedBy: 'admin@example.com',
    });
    await recordPlaybook(getDb(), { version: V, state: 'applied', note: 'settled' });
    expect((await ledgerFor(getDb(), V))?.decidedBy).toBe('admin@example.com');
  });

  test('an unknown state is refused by name, not by SQLSTATE 23514', async () => {
    await expect(
      recordPlaybook(getDb(), { version: V, state: 'best_effort' as never, note: 'nope' }),
    ).rejects.toThrow("unknown playbook state 'best_effort'");
  });
});

describe('checklist', () => {
  const items = [{
    version: V, key: 'pre-0-50-0-0-cutover-attested',
    prompt: 'Confirm the v0.50.0.0 coordinated cutover ran on this database.',
    why: 'Our ledger was never written before Slice 3.5, so no row proves it and the binary version alone does not.',
  }];

  test('opening a checklist writes pending rows', async () => {
    const ids = await openChecklist(getDb(), RUN, items);
    expect(ids).toHaveLength(1);
    const pending = await pendingDecisions(getDb());
    expect(pending.map((p) => p.key)).toContain('pre-0-50-0-0-cutover-attested');
    expect(pending.find((p) => p.key === items[0]!.key)!.state).toBe('pending');
  });

  test('re-opening the same checklist for a resumed run is idempotent', async () => {
    await openChecklist(getDb(), RUN, items);
    await openChecklist(getDb(), RUN, items);
    const rows = await getDb().select().from(schema.upgradeChecklistItems)
      .where(eq(schema.upgradeChecklistItems.gbrainVersion, V));
    expect(rows).toHaveLength(1);
  });

  test('a pending row survives the control plane going away', async () => {
    await openChecklist(getDb(), RUN, items);
    // D2 / honesty rule 8 in miniature: end the pool the way a control-plane
    // restart does, then read it back through a brand-new one.
    await closeDb();
    pinDb();
    const pending = await pendingDecisions(getDb());
    expect(pending.map((p) => p.key)).toContain('pre-0-50-0-0-cutover-attested');
  });

  test('deferring records the actor but keeps the item pending', async () => {
    const [id] = await openChecklist(getDb(), RUN, items);
    expect(await ackChecklistItem(getDb(), id!, 'deferred', 'admin@example.com')).toBe(true);
    const pending = await pendingDecisions(getDb());
    const row = pending.find((p) => p.id === id);
    expect(row?.state).toBe('pending');
    expect(row?.decidedBy).toBe('admin@example.com');
  });

  test('acknowledging the last item settles the ledger row to applied', async () => {
    await recordPlaybook(getDb(), { version: V, state: 'awaiting_admin_decision', note: 'opened 1 item' });
    const [id] = await openChecklist(getDb(), RUN, items);
    expect(await ackChecklistItem(getDb(), id!, 'acknowledged', 'admin@example.com')).toBe(true);
    // Scoped to V: pendingDecisions is global, and a sibling suite may hold a
    // pending row for another version in the same shared database.
    expect((await pendingDecisions(getDb())).filter((p) => p.version === V)).toHaveLength(0);
    const row = await ledgerFor(getDb(), V);
    expect(row?.state).toBe('applied');
    expect(row?.decidedBy).toBe('admin@example.com');
  });

  test('acknowledging an unknown id changes nothing and says so', async () => {
    expect(await ackChecklistItem(getDb(), 'no-such-id', 'acknowledged', 'admin@example.com')).toBe(false);
  });
});
