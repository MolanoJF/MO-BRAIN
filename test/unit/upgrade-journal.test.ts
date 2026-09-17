import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal, appendEvent, readJournal } from '../../src/upgrade/journal.ts';
import { UPGRADE_RUN_STATES } from '../../src/upgrade/types.ts';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});
async function scratch(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'upgrade-journal-'));
  return dir;
}

describe('journal', () => {
  test('seq is monotonic from 1', async () => {
    const d = await scratch();
    const j = await openJournal(d, 'run-1');
    const e1 = await appendEvent(j, { step: 'preflight', message: 'checks ok' });
    const e2 = await appendEvent(j, { step: 'quiesce', message: 'stopping services' });
    const e3 = await appendEvent(j, { step: 'quiesce', level: 'warn', message: 'worker took longer' });
    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);
  });

  test('readJournal replays events in append order', async () => {
    const d = await scratch();
    const j = await openJournal(d, 'run-2');
    await appendEvent(j, { step: 'preflight', message: 'a' });
    await appendEvent(j, { step: 'quiesce', message: 'b' });
    await appendEvent(j, { step: 'snapshot', message: 'c' });
    const events = await readJournal(d, 'run-2');
    expect(events.map((e) => e.step)).toEqual(['preflight', 'quiesce', 'snapshot']);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.level === 'info')).toBe(true);
  });

  test('defaults level to info and carries structured data through', async () => {
    const d = await scratch();
    const j = await openJournal(d, 'run-3');
    const e = await appendEvent(j, {
      step: 'gate', message: 'doctor regressed', data: { check: 'schema_version' },
    });
    expect(e.level).toBe('info');
    expect(e.data).toEqual({ check: 'schema_version' });
  });

  // A crash mid-write leaves a half-written last line on disk. That must
  // never poison replay of everything written BEFORE the crash, and it
  // must never masquerade as a real event either — it is dropped, not repaired.
  test('a truncated LAST line is dropped silently; the next append resumes at the right seq', async () => {
    const d = await scratch();
    const j = await openJournal(d, 'run-4');
    await appendEvent(j, { step: 'preflight', message: 'a' });
    await appendEvent(j, { step: 'quiesce', message: 'b' });
    await Bun.write(j.path, (await Bun.file(j.path).text()) + '{"seq":3,"step":"snap');

    const events = await readJournal(d, 'run-4');
    expect(events.map((e) => e.step)).toEqual(['preflight', 'quiesce']);

    const recovered = await appendEvent(j, { step: 'snapshot', message: 'retried after crash' });
    expect(recovered.seq).toBe(3); // not 4 — the truncated attempt never counted
  });

  // A bad line that is NOT the last one is real corruption, not a crash
  // artifact, and must be loud, not silently dropped like the trailing case.
  test('a corrupt line in the MIDDLE of the file throws instead of being dropped', async () => {
    const d = await scratch();
    const j = await openJournal(d, 'run-5');
    await appendEvent(j, { step: 'preflight', message: 'a' });
    const text = await Bun.file(j.path).text();
    await Bun.write(j.path, text + 'not-json-at-all\n' + JSON.stringify({
      seq: 2, at: new Date().toISOString(), step: 'quiesce', level: 'info', message: 'b',
    }) + '\n');
    await expect(readJournal(d, 'run-5')).rejects.toThrow(/corrupt/);
  });

  test('openJournal is idempotent — reopening an existing run does not truncate it', async () => {
    const d = await scratch();
    const j1 = await openJournal(d, 'run-6');
    await appendEvent(j1, { step: 'preflight', message: 'a' });
    const j2 = await openJournal(d, 'run-6');
    const next = await appendEvent(j2, { step: 'quiesce', message: 'b' });
    expect(next.seq).toBe(2);
  });

  // BUG 2 (Task 17): `openJournal` joins `runId` onto the directory it is
  // handed, so a caller that passes the RUN directory nests the journal one
  // level too deep (`<root>/<runId>/<runId>/journal.ndjson`) and the reconciler
  // — which reads `<root>/<runId>/journal.ndjson` (src/upgrade/reconcile.ts:120)
  // — never finds a real run. This asserts the exact path both sides agree on.
  test('a run journal lands exactly where the reconciler looks', async () => {
    const root = await scratch();
    const j = await openJournal(root, 'run-reconcile');
    expect(j.path).toBe(join(root, 'run-reconcile', 'journal.ndjson'));
    await appendEvent(j, { step: 'planned', message: 'x' });
    expect(await Bun.file(join(root, 'run-reconcile', 'journal.ndjson')).exists()).toBe(true);
    // The reconciler's reader takes the same `(root, runId)` and finds it.
    expect((await readJournal(root, 'run-reconcile')).map((e) => e.step)).toEqual(['planned']);
  });

  // The production caller must hand openJournal the ROOT. Pinned mechanically
  // because that is the half unit-testing the module cannot reach.
  test('the host CLI opens the journal at UPGRADE_DIR, not the run directory', async () => {
    const src = await Bun.file('scripts/upgrade.ts').text();
    expect(src).toContain('openJournal(UPGRADE_DIR, runId)');
    expect(src).not.toMatch(/openJournal\(\s*upgradeDir/);
    expect(src).toContain('readJournal(UPGRADE_DIR, id)');
    expect(src).not.toMatch(/readJournal\(\s*join\(UPGRADE_DIR, id\)/);
  });
});

describe('UpgradeRunState agreement with schema.ts', () => {
  // Task 3's CHECK and this union are a drifting pair waiting to happen — a
  // state present in one but not the other is a silent write failure in
  // production, not a type error caught at build time.
  test('the TS union and the upgrade_run_state_valid CHECK name exactly the same states', async () => {
    const schemaSrc = await Bun.file('src/control/db/schema.ts').text();
    const match = schemaSrc.match(/check\('upgrade_run_state_valid'[^)]*?in\s*\(([^)]*)\)/s);
    expect(match).not.toBeNull();
    const fromCheck = match![1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    expect(new Set(fromCheck)).toEqual(new Set(UPGRADE_RUN_STATES));
    expect(fromCheck.length).toBe(UPGRADE_RUN_STATES.length);
  });
});
