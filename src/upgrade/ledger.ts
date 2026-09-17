import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, schema } from '../control/db/client.ts';
import type { ChecklistItemSpec } from './playbooks/types.ts';

export type ControlDb = ReturnType<typeof getDb>;

/** The four states src/control/db/schema.ts already CHECKs on playbook_ledger. */
export const PLAYBOOK_STATES = ['pending', 'applied', 'skipped', 'awaiting_admin_decision'] as const;
export type PlaybookState = (typeof PLAYBOOK_STATES)[number];

/**
 * One row per gbrain version, because `gbrain_version` is UNIQUE. The row is
 * therefore the INSTALL's history for that version, not one run's outcome:
 * upgrade to 0.50.2.0, roll back, upgrade again, and there is still exactly one
 * row.
 *
 * That is why `notes` appends instead of replacing. Each write adds one
 * timestamped line, so the row reads as a log — `applied by run A`,
 * `rolled back by run A`, `applied by run B` — and the current `state` column
 * is the last line's verdict. Task 12's rollback writes `pending` back with a
 * line naming the run that undid it, so a row can never say `applied` about a
 * version the binary is no longer at.
 */
export async function recordPlaybook(
  db: ControlDb,
  args: { version: string; state: PlaybookState; note: string; decidedBy?: string; now?: Date },
): Promise<void> {
  if (!(PLAYBOOK_STATES as readonly string[]).includes(args.state)) {
    throw new Error(
      `unknown playbook state '${args.state}': expected one of ${PLAYBOOK_STATES.join(', ')}`,
    );
  }
  const at = args.now ?? new Date();
  const line = `${at.toISOString()} ${args.state} — ${args.note}\n`;

  await db.insert(schema.playbookLedger).values({
    id: randomUUID(),
    gbrainVersion: args.version,
    state: args.state,
    notes: line,
    decidedBy: args.decidedBy ?? null,
    updatedAt: at,
  }).onConflictDoUpdate({
    target: schema.playbookLedger.gbrainVersion,
    set: {
      state: args.state,
      // In ON CONFLICT DO UPDATE the qualified column is the EXISTING row.
      notes: sql`coalesce(${schema.playbookLedger.notes}, '') || ${line}`,
      updatedAt: at,
      // Only when supplied: a later automated write must not erase the human
      // who decided the checklist.
      ...(args.decidedBy ? { decidedBy: args.decidedBy } : {}),
    },
  });
}

export async function ledgerFor(db: ControlDb, version: string) {
  const [row] = await db.select().from(schema.playbookLedger)
    .where(eq(schema.playbookLedger.gbrainVersion, version)).limit(1);
  return row ?? null;
}

export type OpenChecklistItem = ChecklistItemSpec & { version: string };

/**
 * Open the judgement residue as rows a human decides. Idempotent on
 * (runId, itemKey) so a resumed run re-opens nothing.
 *
 * The checklist vocabulary is Task 3's, not the playbook ledger's: a freshly
 * opened item is `pending`. There is no `awaiting_admin_decision` here — that
 * value belongs to `playbook_ledger` alone.
 */
export async function openChecklist(
  db: ControlDb, runId: string, items: OpenChecklistItem[],
): Promise<string[]> {
  if (items.length === 0) return [];
  const values = items.map((i) => ({
    id: randomUUID(),
    runId,
    gbrainVersion: i.version,
    itemKey: i.key,
    prompt: i.prompt,
    why: i.why,
    state: 'pending' as const,
  }));
  await db.insert(schema.upgradeChecklistItems).values(values)
    .onConflictDoNothing({
      target: [schema.upgradeChecklistItems.runId, schema.upgradeChecklistItems.itemKey],
    });
  const rows = await db.select({ id: schema.upgradeChecklistItems.id })
    .from(schema.upgradeChecklistItems)
    .where(and(
      eq(schema.upgradeChecklistItems.runId, runId),
      inArray(schema.upgradeChecklistItems.itemKey, items.map((i) => i.key)),
    ));
  return rows.map((r) => r.id);
}

export type PendingDecision = {
  id: string; runId: string; version: string; key: string; prompt: string; why: string | null;
  state: string; decidedBy: string | null; decidedAt: Date | null;
};

/**
 * Everything still undecided, ordered deterministically. Task 3's checklist
 * table has no `createdAt` column (the plan's Consumes list assumed one), so
 * "oldest first" is not recoverable; the order is (runId, itemKey), which is
 * stable across reads.
 *
 * A `deferred` item is stored as `pending` on purpose: deferring records that
 * a human looked and chose to wait, which is an audit trail, not a resolution.
 * Dropping it here would take the banner down with nothing decided.
 */
export async function pendingDecisions(db: ControlDb): Promise<PendingDecision[]> {
  const rows = await db.select().from(schema.upgradeChecklistItems)
    .where(eq(schema.upgradeChecklistItems.state, 'pending'))
    .orderBy(asc(schema.upgradeChecklistItems.runId), asc(schema.upgradeChecklistItems.itemKey));
  return rows.map((r) => ({
    id: r.id, runId: r.runId, version: r.gbrainVersion, key: r.itemKey,
    prompt: r.prompt, why: r.why, state: r.state,
    decidedBy: r.decidedBy, decidedAt: r.decidedAt,
  }));
}

/**
 * Record a human's decision. Returns whether a row changed, so an API can 404
 * an unknown id instead of reporting a success nobody caused.
 *
 * The stored vocabulary is Task 3's (`pending | acknowledged | declined`):
 * `acknowledged` and `declined` are terminal, while `deferred` records the
 * actor and leaves the row `pending` so it stays in `pendingDecisions`.
 *
 * Acknowledging the LAST pending item for a version settles that version's
 * ledger row to `applied` and names the actor — the run and the checklist then
 * agree. Declining does not settle: a declined attestation is not a clean
 * upgrade, so the ledger must not say `applied`.
 */
export async function ackChecklistItem(
  db: ControlDb, id: string, decision: 'acknowledged' | 'declined' | 'deferred', actor: string,
): Promise<boolean> {
  const stored = decision === 'deferred' ? 'pending' : decision;
  const [row] = await db.update(schema.upgradeChecklistItems)
    .set({ state: stored, decidedBy: actor, decidedAt: new Date() })
    .where(and(
      eq(schema.upgradeChecklistItems.id, id),
      eq(schema.upgradeChecklistItems.state, 'pending'),
    ))
    .returning({
      version: schema.upgradeChecklistItems.gbrainVersion,
      key: schema.upgradeChecklistItems.itemKey,
    });
  if (!row) return false;

  if (decision === 'acknowledged') {
    const remaining = await db.select({ id: schema.upgradeChecklistItems.id })
      .from(schema.upgradeChecklistItems)
      .where(and(
        eq(schema.upgradeChecklistItems.gbrainVersion, row.version),
        eq(schema.upgradeChecklistItems.state, 'pending'),
      ));
    if (remaining.length === 0) {
      await recordPlaybook(db, {
        version: row.version, state: 'applied', decidedBy: actor,
        note: `every checklist item decided; last was '${row.key}', acknowledged by ${actor}`,
      });
    }
  }
  return true;
}
