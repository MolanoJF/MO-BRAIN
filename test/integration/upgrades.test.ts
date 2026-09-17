import { mock, test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

type DetectResult = {
  current_version: string; latest_version: string; update_available: boolean;
  changelog_diff: string; release_url: string; error?: 'network_error' | 'no_releases';
};
let detectHandler: () => Promise<DetectResult> = async () => ({
  current_version: '0.50.0.0', latest_version: '0.50.5.0', update_available: true,
  changelog_diff: 'security hardening', release_url: 'https://example.test',
});
mock.module('../../src/upgrade/detect.ts', () => ({
  detectUpdate: async () => detectHandler(),
}));

type DriftResult = { signal: 'drift' | 'no_drift' | 'single_snapshot'; from: string; to: string; diff: unknown };
let driftHandler: (from: string, to: string) => Promise<DriftResult> = async (from, to) => ({
  signal: 'single_snapshot', from, to, diff: null,
});
mock.module('../../src/upgrade/capability.ts', () => ({
  driftBetween: async (from: string, to: string) => driftHandler(from, to),
}));

// Task 9's real registry is version-specific and grows over time; the route
// only needs something with a `.version` field to build its IN clause, so a
// fixture keeps this file independent of what playbooks actually exist at
// whatever pin is checked out when it runs.
mock.module('../../src/upgrade/playbooks/index.ts', () => ({
  playbooksFor: () => [{ version: '9.9.9-fixture', noPlaybookRequired: false }],
}));

const { default: app } = await import('../../src/control/app.ts');
const { runMigrations, getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { eq, inArray } = await import('drizzle-orm');
const { reconcileJournals, UPGRADE_RECONCILE_INTERVAL_MS } = await import('../../src/upgrade/reconcile.ts');
const { UPGRADE_HOST_ONLY_ERROR } = await import('../../src/control/routes/upgrades.ts');

pinDb();

const RUN = randomUUID().slice(0, 8);
const ORG = randomUUID();
const NOPE = randomUUID();
const PASS = 'a-long-enough-password';
const createdUsers: string[] = [];
const createdRunIds: string[] = [];
let upgradeDir: string;
let adminCookie = '', memberCookie = '', viewerCookie = '';

async function addUser(email: string, role: 'owner' | 'admin' | 'member' | 'viewer'): Promise<void> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASS, name: email }),
  });
  expect(res.status).toBe(200);
  const [user] = await getDb().select().from(schema.users).where(eq(schema.users.email, email));
  createdUsers.push(user!.id);
  await getDb().insert(schema.memberships).values({ id: randomUUID(), userId: user!.id, organizationId: ORG, role });
}

async function signIn(email: string): Promise<string> {
  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie') ?? '';
}

async function hit(method: string, path: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  const hasBody = method !== 'GET' && method !== 'DELETE';
  if (hasBody || body !== undefined) headers['content-type'] = 'application/json';
  return app.request(path, { method, headers, body: hasBody ? JSON.stringify(body ?? {}) : undefined });
}

function freshRunId(): string {
  const id = randomUUID();
  createdRunIds.push(id);
  return id;
}

// Journal events are written in the typed NDJSON shape the reconciler consumes:
// { runId, seq, at, type, data }. The host CLI's own writer (`appendEvent`) puts
// the state in `step`; the reconciler normalizes both (see reconcile.ts).
async function writeLine(runId: string, seq: number, type: string, data: unknown, at = new Date().toISOString()) {
  await mkdir(join(upgradeDir, runId), { recursive: true });
  await writeFile(
    join(upgradeDir, runId, 'journal.ndjson'),
    JSON.stringify({ runId, seq, at, type, data }) + '\n',
    { flag: 'a' },
  );
}

async function writeRaw(runId: string, text: string) {
  await mkdir(join(upgradeDir, runId), { recursive: true });
  await writeFile(join(upgradeDir, runId, 'journal.ndjson'), text, { flag: 'a' });
}

async function insertRun(over: Record<string, unknown> = {}): Promise<string> {
  const id = freshRunId();
  await getDb().insert(schema.upgradeRuns).values({
    id, fromVersion: '0.50.0.0', toVersion: '0.50.5.0', state: 'completed',
    startedAt: new Date(), endedAt: new Date(), createdBy: 'test', ...over,
  });
  return id;
}

beforeAll(async () => {
  await runMigrations();
  upgradeDir = await mkdtemp(join(tmpdir(), 'bs-upgrades-'));
  await getDb().insert(schema.organizations).values({ id: ORG, name: 'Upgrades', slug: `upgrades-${RUN}` });
  await addUser(`up-admin-${RUN}@example.test`, 'admin');
  await addUser(`up-member-${RUN}@example.test`, 'member');
  await addUser(`up-viewer-${RUN}@example.test`, 'viewer');
  adminCookie = await signIn(`up-admin-${RUN}@example.test`);
  memberCookie = await signIn(`up-member-${RUN}@example.test`);
  viewerCookie = await signIn(`up-viewer-${RUN}@example.test`);
}, 90_000);

afterAll(async () => {
  if (createdRunIds.length > 0) {
    await getDb().delete(schema.upgradeEvents).where(inArray(schema.upgradeEvents.runId, createdRunIds));
    await getDb().delete(schema.upgradeChecklistItems).where(inArray(schema.upgradeChecklistItems.runId, createdRunIds));
    await getDb().delete(schema.upgradeRuns).where(inArray(schema.upgradeRuns.id, createdRunIds));
  }
  await getDb().delete(schema.playbookLedger).where(eq(schema.playbookLedger.gbrainVersion, '9.9.9-fixture'));
  await getDb().delete(schema.organizations).where(eq(schema.organizations.id, ORG));
  await getDb().delete(schema.users).where(inArray(schema.users.id, createdUsers));
  await closeDb();
});

describe('reconcileJournals', () => {
  test('a fresh journal imports the run and its events', async () => {
    const runId = freshRunId();
    await writeLine(runId, 1, 'run_started', { fromVersion: '0.50.0.0', toVersion: '0.50.5.0', createdBy: 'operator' });
    await writeLine(runId, 2, 'state_changed', { to: 'preflight_ok' });

    const summary = await reconcileJournals(getDb(), upgradeDir);
    expect(summary.runsScanned).toBeGreaterThan(0);
    expect(summary.eventsImported).toBeGreaterThanOrEqual(2);

    const [run] = await getDb().select().from(schema.upgradeRuns).where(eq(schema.upgradeRuns.id, runId));
    expect(run!.state).toBe('preflight_ok');
    expect(run!.fromVersion).toBe('0.50.0.0');

    const events = await getDb().select().from(schema.upgradeEvents).where(eq(schema.upgradeEvents.runId, runId));
    expect(events).toHaveLength(2);
  });

  test('re-importing the same journal is a no-op — UNIQUE (runId, seq) is the idempotency key', async () => {
    const runId = freshRunId();
    await writeLine(runId, 1, 'run_started', { fromVersion: '0.50.0.0', toVersion: '0.50.5.0', createdBy: 'operator' });
    await reconcileJournals(getDb(), upgradeDir);
    const before = await getDb().select().from(schema.upgradeEvents).where(eq(schema.upgradeEvents.runId, runId));
    await reconcileJournals(getDb(), upgradeDir);
    const after = await getDb().select().from(schema.upgradeEvents).where(eq(schema.upgradeEvents.runId, runId));
    expect(after).toHaveLength(before.length);
    expect(after).toHaveLength(1);
  });

  test('a truncated tail line imports everything complete and reports the truncation', async () => {
    const runId = freshRunId();
    const complete = [
      JSON.stringify({ runId, seq: 1, at: new Date().toISOString(), type: 'run_started', data: { fromVersion: '0.50.0.0', toVersion: '0.50.5.0', createdBy: 'operator' } }),
      JSON.stringify({ runId, seq: 2, at: new Date().toISOString(), type: 'state_changed', data: { to: 'preflight_ok' } }),
    ].join('\n') + '\n';
    // A real partial write: cut off mid-object, no trailing newline — exactly
    // what a reconcile pass can see if it reads while scripts/upgrade.ts is
    // mid-append.
    const partial = `{"runId":"${runId}","seq":3,"at":"2026-0`;
    await writeRaw(runId, complete + partial);

    const summary = await reconcileJournals(getDb(), upgradeDir);
    expect(summary.eventsImported).toBeGreaterThanOrEqual(2);
    expect(summary.truncatedRuns).toContain(runId);

    const events = await getDb().select().from(schema.upgradeEvents).where(eq(schema.upgradeEvents.runId, runId));
    expect(events).toHaveLength(2);
  });

  test('the DB never goes backwards — a stale state_changed event is logged but not applied', async () => {
    const runId = freshRunId();
    await writeLine(runId, 1, 'run_started', { fromVersion: '0.50.0.0', toVersion: '0.50.5.0', createdBy: 'operator' });
    await writeLine(runId, 2, 'state_changed', { to: 'preflight_ok' });
    await writeLine(runId, 3, 'state_changed', { to: 'planned' }); // deliberately regressive

    const summary = await reconcileJournals(getDb(), upgradeDir);
    expect(summary.eventsImported).toBeGreaterThanOrEqual(3);

    const [run] = await getDb().select().from(schema.upgradeRuns).where(eq(schema.upgradeRuns.id, runId));
    expect(run!.state).toBe('preflight_ok'); // the derived state never regresses...

    const events = await getDb().select().from(schema.upgradeEvents).where(eq(schema.upgradeEvents.runId, runId));
    // ...but the log stays complete. `upgrade_events.step` carries the event
    // type (Task 3's schema has no `type` column).
    expect(events.map((e) => e.step)).toEqual(['run_started', 'state_changed', 'state_changed']);
  });

  test('a playbooks_applied event replays into the ledger and opens the checklist', async () => {
    const runId = freshRunId();
    await writeLine(runId, 1, 'run_started', { fromVersion: '0.50.0.0', toVersion: '0.50.5.0', createdBy: 'operator' });
    await writeLine(runId, 2, 'playbooks_applied', {
      ledger: [{ gbrainVersion: '9.9.9-fixture', state: 'applied', notes: 'upstream ships no playbook for this version — CHANGELOG confirmed' }],
      checklist: [{ itemKey: 'confirm-thing', gbrainVersion: '9.9.9-fixture', prompt: 'Confirm the thing', why: 'because' }],
    });

    await reconcileJournals(getDb(), upgradeDir);

    const [ledgerRow] = await getDb().select().from(schema.playbookLedger)
      .where(eq(schema.playbookLedger.gbrainVersion, '9.9.9-fixture'));
    expect(ledgerRow!.state).toBe('applied');
    expect(ledgerRow!.notes).toContain('no playbook');

    const checklist = await getDb().select().from(schema.upgradeChecklistItems).where(eq(schema.upgradeChecklistItems.runId, runId));
    expect(checklist).toHaveLength(1);
    expect(checklist[0]!.itemKey).toBe('confirm-thing');
    // Task 3's CHECK allows pending|acknowledged|declined; a freshly opened
    // item is `pending` (Task 9's openChecklist).
    expect(checklist[0]!.state).toBe('pending');
  });

  test('a missing upgrade directory is a clean zero, not a crash', async () => {
    const summary = await reconcileJournals(getDb(), join(upgradeDir, 'does-not-exist'));
    expect(summary).toEqual({ runsScanned: 0, eventsImported: 0, eventsSkipped: 0, truncatedRuns: [] });
  });

  test('the timer interval is a stated number, not ad hoc', () => {
    expect(UPGRADE_RECONCILE_INTERVAL_MS).toBe(60_000);
  });
});

describe('upgrade routes', () => {
  test('an unauthenticated caller gets 401 on every upgrade route', async () => {
    const table: Array<[string, string]> = [
      ['GET', '/api/upgrades'],
      ['GET', '/api/upgrades/available'],
      ['GET', '/api/upgrades/drift?from=0.50.0.0&to=0.50.5.0'],
      ['GET', '/api/upgrades/pending-decisions'],
      ['GET', `/api/upgrades/${NOPE}`],
      ['POST', '/api/upgrades'],
      ['POST', `/api/upgrades/checklist/${NOPE}/ack`],
      ['POST', `/api/upgrades/checklist/${NOPE}/decline`],
    ];
    for (const [method, path] of table) expect((await hit(method, path)).status).toBe(401);
  });

  test('POST /api/upgrades is 503, unconditionally — starting an upgrade is a host operation', async () => {
    const res = await hit('POST', '/api/upgrades', adminCookie);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(UPGRADE_HOST_ONLY_ERROR);
    expect(body.error).toMatch(/scripts\/upgrade\.ts/);
    expect(body.error).toMatch(/host/i);
  });

  test('a viewer reads every GET route, and a member is refused the same as a viewer for POST', async () => {
    expect((await hit('GET', '/api/upgrades', viewerCookie)).status).toBe(200);
    expect((await hit('GET', '/api/upgrades/available', viewerCookie)).status).toBe(200);
    expect((await hit('GET', '/api/upgrades/drift?from=0.50.0.0&to=0.50.5.0', viewerCookie)).status).toBe(200);
    expect((await hit('GET', '/api/upgrades/pending-decisions', viewerCookie)).status).toBe(200);
    expect((await hit('POST', '/api/upgrades', viewerCookie)).status).toBe(403);
    expect((await hit('POST', '/api/upgrades', memberCookie)).status).toBe(403);
  });

  test('a failed check-update renders as "could not check" — the .error survives, never dropped', async () => {
    detectHandler = async () => ({
      current_version: '0.50.0.0', latest_version: '', update_available: false,
      changelog_diff: '', release_url: '', error: 'network_error',
    });
    const res = await hit('GET', '/api/upgrades/available', viewerCookie);
    expect(res.status).toBe(200);
    const body = await res.json() as DetectResult;
    expect(body.error).toBe('network_error');
    expect(body.update_available).toBe(false);
  });

  test('drift with only one recorded snapshot passes single_snapshot through, not an empty diff', async () => {
    driftHandler = async (from, to) => ({ signal: 'single_snapshot', from, to, diff: null });
    const res = await hit('GET', '/api/upgrades/drift?from=0.50.0.0&to=0.50.5.0', viewerCookie);
    const body = await res.json() as DriftResult;
    expect(body.signal).toBe('single_snapshot');
    expect(body.signal).not.toBe('no_drift');
    expect(body.diff).toBeNull();
  });

  test('drift refuses without both versions named', async () => {
    expect((await hit('GET', '/api/upgrades/drift?from=0.50.0.0', viewerCookie)).status).toBe(400);
  });

  test('GET /api/upgrades lists run history', async () => {
    await insertRun();
    const res = await hit('GET', '/api/upgrades', viewerCookie);
    expect(res.status).toBe(200);
    const body = await res.json() as { runs: unknown[] };
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs.length).toBeGreaterThan(0);
  });

  test('GET /api/upgrades/:id assembles the run, its events, checklist and the ledger rows it touched', async () => {
    const runId = await insertRun();
    await getDb().insert(schema.upgradeEvents).values([
      { id: randomUUID(), runId, seq: 1, at: new Date(), step: 'run_started', message: '', data: {} },
      { id: randomUUID(), runId, seq: 2, at: new Date(), step: 'state_changed', message: '', data: { to: 'completed' } },
    ]);
    await getDb().insert(schema.upgradeChecklistItems).values({
      id: randomUUID(), runId, gbrainVersion: '9.9.9-fixture', itemKey: 'confirm-thing',
      prompt: 'Confirm the thing', why: 'because', state: 'pending',
    });
    await getDb().insert(schema.playbookLedger).values({
      id: randomUUID(), gbrainVersion: '9.9.9-fixture', state: 'applied', notes: 'test evidence',
    }).onConflictDoNothing();

    const res = await hit('GET', `/api/upgrades/${runId}`, viewerCookie);
    expect(res.status).toBe(200);
    const body = await res.json() as { run: { id: string }; events: Array<{ step: string }>; checklist: unknown[]; ledger: Array<{ gbrainVersion: string }> };
    expect(body.run.id).toBe(runId);
    expect(body.events.map((e) => e.step)).toEqual(['run_started', 'state_changed']);
    expect(body.checklist).toHaveLength(1);
    expect(body.ledger.map((l) => l.gbrainVersion)).toEqual(['9.9.9-fixture']);
  });

  test('an unknown run id is a 404', async () => {
    expect((await hit('GET', `/api/upgrades/${NOPE}`, viewerCookie)).status).toBe(404);
  });

  test('acknowledging a checklist item writes the audit row before the state change, admin only', async () => {
    const runId = await insertRun();
    const itemId = randomUUID();
    await getDb().insert(schema.upgradeChecklistItems).values({
      id: itemId, runId, gbrainVersion: '9.9.9-fixture', itemKey: 'confirm-thing',
      prompt: 'Confirm the thing', why: 'because', state: 'pending',
    });

    expect((await hit('POST', `/api/upgrades/checklist/${itemId}/ack`, viewerCookie)).status).toBe(403);
    expect((await hit('POST', `/api/upgrades/checklist/${itemId}/ack`, memberCookie)).status).toBe(403);

    const res = await hit('POST', `/api/upgrades/checklist/${itemId}/ack`, adminCookie);
    expect(res.status).toBe(200);
    const body = await res.json() as { item: { state: string } };
    expect(body.item.state).toBe('acknowledged');

    const [row] = await getDb().select().from(schema.upgradeChecklistItems).where(eq(schema.upgradeChecklistItems.id, itemId));
    expect(row!.state).toBe('acknowledged');
    expect(row!.decidedBy).toBeTruthy();
    expect(row!.decidedAt).toBeTruthy();

    // The audit row IS the durable record, written before the state change —
    // the same idiom as schedule-alert acknowledgement and connection revoke.
    const audit = await getDb().select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'upgrade.checklist.acknowledged'));
    expect(audit.some((a) => a.target === itemId)).toBe(true);
  });

  test('declining a checklist item is the same audited path, with its own action name', async () => {
    const runId = await insertRun();
    const itemId = randomUUID();
    await getDb().insert(schema.upgradeChecklistItems).values({
      id: itemId, runId, gbrainVersion: '9.9.9-fixture', itemKey: 'confirm-other',
      prompt: 'p', why: 'w', state: 'pending',
    });
    const res = await hit('POST', `/api/upgrades/checklist/${itemId}/decline`, adminCookie);
    expect(res.status).toBe(200);
    const [row] = await getDb().select().from(schema.upgradeChecklistItems).where(eq(schema.upgradeChecklistItems.id, itemId));
    expect(row!.state).toBe('declined');
    const audit = await getDb().select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'upgrade.checklist.declined'));
    expect(audit.some((a) => a.target === itemId)).toBe(true);
  });

  test('an unknown checklist item is a 404, never a 403 leak', async () => {
    expect((await hit('POST', `/api/upgrades/checklist/${NOPE}/ack`, adminCookie)).status).toBe(404);
  });
});
