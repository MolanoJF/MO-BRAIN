import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, type Role } from '../rbac.ts';
import { callOps } from '../opsClient.ts';
import { detectUpdate } from '../../upgrade/detect.ts';
import { driftBetween, SingleSnapshotError } from '../../upgrade/capability.ts';
import { playbooksFor } from '../../upgrade/playbooks/index.ts';
import { ackChecklistItem, pendingDecisions } from '../../upgrade/ledger.ts';

export const upgrades = new Hono();

async function audit(actor: string, action: string, target: string, after: unknown) {
  // upgrade_runs/events/checklist/ledger are deployment-level, not org-scoped
  // (there is one gbrain binary for the whole stack) — same shape as
  // capability_snapshots and playbook_ledger already are.
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: null, actor, action, target, before: null, after: after as object });
}

const guard = (
  min: Role,
  handler: (c: any, ctx: { userId: string; orgId: string; role: Role }) => Promise<Response>,
) =>
  async (c: any) => {
    let ctx: { userId: string; orgId: string; role: Role };
    try { ctx = await requireRole(c, min); } catch (r) { return r as Response; }
    try { return await handler(c, ctx); }
    catch (e: any) { return c.json({ error: e?.message ?? 'upgrades_error' }, e?.status ?? 400); }
  };

/**
 * D1: scripts/upgrade.ts, run by a human on the Docker host, is the only
 * thing that quiesces services or swaps images — and it holds no control-DB
 * connection (D2), so this route does not even import it. Unlike backup,
 * whose route calls the SAME runBackup() the host CLI does, gated by a
 * docker-availability check, there is no conditional path here where
 * starting an upgrade from the control plane could ever work: doing so would
 * mean shelling out to `docker compose` from inside a container that has
 * neither a Docker socket nor a Docker CLI (S2). This route exists only so a
 * stray POST gets an honest 503 naming the real command, not a bare 404.
 */
export const UPGRADE_HOST_ONLY_ERROR =
  'Starting an upgrade is a host operation. Run scripts/upgrade.ts on the Docker host — '
  + 'the control-plane container cannot invoke docker compose.';

upgrades.post('/upgrades', guard('admin', async (c) => c.json({ error: UPGRADE_HOST_ONLY_ERROR }, 503)));

upgrades.get('/upgrades', guard('viewer', async (c) => {
  const runs = await getDb().select().from(schema.upgradeRuns).orderBy(desc(schema.upgradeRuns.startedAt));
  return c.json({ runs });
}));

upgrades.get('/upgrades/available', guard('viewer', async (c) => {
  // Honesty rule 1 / U1: check-update NEVER sets an exit code, so `.error`
  // is the only signal a network failure happened at all. Fetch the body here
  // (the route's job — detectUpdate is pure and never calls the RPC), then
  // classify. When the ops relay itself is unreachable the body stays null and
  // detectUpdate reports a malformed/unknown check — never "up to date". Label
  // that specific case `network_error`, which is what it actually is: the check
  // could not run.
  let body: unknown = null;
  let relayFailed = false;
  try {
    body = (await callOps('checkUpdate', {}, { json: true, timeoutMs: 5_000 })).json ?? null;
  } catch {
    relayFailed = true;
  }
  const result = await detectUpdate(body);
  return c.json(relayFailed ? { ...result, error: 'network_error' } : result);
}));

upgrades.get('/upgrades/drift', guard('viewer', async (c) => {
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (!from || !to) return c.json({ error: 'from and to are required' }, 400);
  // Task 8 distinguishes "compared and identical" from "only one side was
  // ever captured" with a `single_snapshot` signal — pass it through as-is
  // rather than flattening both into an empty diff, which would read as
  // "verified no drift" when the honest answer is "nothing to compare."
  // F7: on a fresh deployment Gate B runs before any upgrade leg has captured
  // a snapshot, so this branch is the NORMAL first answer, not an error — a
  // 400 here would claim a client mistake. The writer is now wired
  // (scripts/upgrade.ts captures, reconcile.ts imports), so C10 gets the real
  // two-sided diff once a run has completed.
  try {
    return c.json(await driftBetween(from, to));
  } catch (e) {
    if (e instanceof SingleSnapshotError) {
      return c.json({ single_snapshot: true, available: e.available });
    }
    throw e;
  }
}));

// Before `/upgrades/:id`, so this literal path is never captured by the param.
upgrades.get('/upgrades/pending-decisions', guard('viewer', async (c) => {
  return c.json({ pending: await pendingDecisions(getDb()) });
}));

upgrades.get('/upgrades/:id', guard('viewer', async (c) => {
  const id = c.req.param('id');
  const [run] = await getDb().select().from(schema.upgradeRuns).where(eq(schema.upgradeRuns.id, id));
  if (!run) return c.json({ error: 'not_found' }, 404);

  const events = await getDb().select().from(schema.upgradeEvents)
    .where(eq(schema.upgradeEvents.runId, id)).orderBy(schema.upgradeEvents.seq);
  const checklist = await getDb().select().from(schema.upgradeChecklistItems)
    .where(eq(schema.upgradeChecklistItems.runId, id));

  // playbook_ledger has no runId (Task 9 — a row is the INSTALL's history,
  // not a run's), so the versions THIS run touched come from the same
  // registry lookup the run itself used to decide what to apply.
  const versions = playbooksFor(run.fromVersion, run.toVersion).map((p) => p.version);
  const ledger = versions.length > 0
    ? await getDb().select().from(schema.playbookLedger).where(inArray(schema.playbookLedger.gbrainVersion, versions))
    : [];

  return c.json({ run, events, checklist, ledger });
}));

async function decide(c: any, ctx: { userId: string }, decision: 'acknowledged' | 'declined') {
  const itemId = c.req.param('itemId');
  const [item] = await getDb().select().from(schema.upgradeChecklistItems)
    .where(eq(schema.upgradeChecklistItems.id, itemId));
  if (!item) return c.json({ error: 'not_found' }, 404);

  // The audit row is written BEFORE the state change — the durable record
  // exists even if the process dies between the two writes. Same idiom as
  // schedule-alert acknowledgement and connection revoke.
  await audit(ctx.userId, `upgrade.checklist.${decision}`, itemId, {
    gbrainVersion: item.gbrainVersion, itemKey: item.itemKey,
  });
  // Task 9's ackChecklistItem returns whether a row changed, so re-read the
  // row for the response rather than inventing a return shape it does not have.
  await ackChecklistItem(getDb(), itemId, decision, ctx.userId);
  const [updated] = await getDb().select().from(schema.upgradeChecklistItems)
    .where(eq(schema.upgradeChecklistItems.id, itemId));
  return c.json({ item: updated ?? item });
}

upgrades.post('/upgrades/checklist/:itemId/ack', guard('admin', (c, ctx) => decide(c, ctx, 'acknowledged')));
upgrades.post('/upgrades/checklist/:itemId/decline', guard('admin', (c, ctx) => decide(c, ctx, 'declined')));
