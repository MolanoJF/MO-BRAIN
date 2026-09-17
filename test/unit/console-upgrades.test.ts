import { test, expect, describe, afterEach } from 'bun:test';
import {
  bannerFor, stepStatus, failedStep, rolledBack, runDuration, driftText,
  pendingChecklist, planCommand, runCommand, stepLabel, UPGRADE_STEPS,
} from '../../src/console/pages/Upgrades.tsx';
import { api, upgradeApi } from '../../src/console/api.ts';

describe('the detect banner — honesty rule 1', () => {
  test('a network failure never reads as up to date', () => {
    const banner = bannerFor({
      error: 'network_error', current_version: '0.50.0.0', latest_version: '',
      update_available: false, changelog_diff: '', release_url: '',
    });
    expect(banner).toMatch(/could not check/i);
    expect(banner).not.toMatch(/up to date/i);
  });

  test('no releases reachable is its own honest sentence, not a silent success', () => {
    const banner = bannerFor({
      error: 'no_releases', current_version: '0.50.0.0', latest_version: '',
      update_available: false, changelog_diff: '', release_url: '',
    });
    expect(banner).toMatch(/could not check/i);
  });

  test('a clean check with nothing available says up to date', () => {
    expect(bannerFor({
      current_version: '0.50.5.0', latest_version: '0.50.5.0', update_available: false,
      changelog_diff: '', release_url: '',
    })).toMatch(/up to date/i);
  });

  test('a candidate is offered by name, never applied', () => {
    const banner = bannerFor({
      current_version: '0.50.0.0', latest_version: '0.50.5.0', update_available: true,
      changelog_diff: '', release_url: '',
    });
    expect(banner).toContain('0.50.5.0');
    expect(banner).toContain('0.50.0.0');
  });

  test('a load still in flight is distinct from either outcome', () => {
    expect(bannerFor(null)).not.toMatch(/up to date|could not check/i);
  });
});

describe('the run timeline', () => {
  const ev = (type: string, step: string) => ({ id: '1', runId: 'r1', seq: 1, at: '2026-09-16T00:00:00Z', type, data: { step } });

  test('every one of the eight steps has a human label', () => {
    expect(UPGRADE_STEPS).toHaveLength(8);
    for (const step of UPGRADE_STEPS) expect(stepLabel(step)).not.toBe(step);
  });

  test('a step with no event is pending, one that started is active, one that finished is done', () => {
    expect(stepStatus([], 'snapshot')).toBe('pending');
    expect(stepStatus([ev('step_started', 'snapshot')], 'snapshot')).toBe('active');
    expect(stepStatus([ev('step_started', 'snapshot'), ev('step_finished', 'snapshot')], 'snapshot')).toBe('done');
  });

  test('a failed step reads as failed even if it also started', () => {
    expect(stepStatus([ev('step_started', 'migrate'), ev('step_failed', 'migrate')], 'migrate')).toBe('failed');
  });

  test('failedStep names which of the eight steps died', () => {
    expect(failedStep([ev('step_started', 'migrate'), ev('step_failed', 'migrate')])).toBe('migrate');
    expect(failedStep([ev('step_started', 'plan'), ev('step_finished', 'plan')])).toBeNull();
  });

  test('a rolled-back run is named as such, not just "failed"', () => {
    const run = { id: 'r1', fromVersion: '0.50.0.0', toVersion: '0.50.5.0', state: 'rolled_back', startedAt: '2026-09-16T00:00:00Z', finishedAt: '2026-09-16T00:05:00Z', snapshotId: 's1', createdBy: 'op' };
    expect(rolledBack(run)).toBe(true);
    expect(rolledBack({ ...run, state: 'failed' })).toBe(false);
  });

  test('duration is measured, not guessed, and an unfinished run says so', () => {
    const started = { id: 'r1', fromVersion: 'a', toVersion: 'b', state: 'snapshotting', startedAt: '2026-09-16T00:00:00Z', finishedAt: null, snapshotId: null, createdBy: 'op' };
    expect(runDuration(started)).toBe('in progress');
    expect(runDuration({ ...started, finishedAt: '2026-09-16T00:00:45Z' })).toBe('45s');
    expect(runDuration({ ...started, finishedAt: '2026-09-16T00:02:30Z' })).toBe('3m');
  });
});

describe('the blocking checklist — honesty rule 8', () => {
  const item = (id: string, state: string) => ({
    id, runId: 'r1', gbrainVersion: '0.50.2.0', itemKey: id, prompt: 'p', why: 'w',
    state, decidedBy: null, decidedAt: null,
  });

  // The plan's sample filtered on 'awaiting_admin_decision'. That is a RUN and
  // playbook_ledger state; the executed checklist table CHECKs only
  // pending|acknowledged|declined (schema.ts:415) and a freshly opened item is
  // 'pending' (ledger.ts openChecklist). Filter on the real vocabulary.
  test('only pending items are awaiting a decision — a decided one drops off', () => {
    const items = [item('a', 'pending'), item('b', 'acknowledged'), item('c', 'declined')];
    expect(pendingChecklist(items).map((i) => i.id)).toEqual(['a']);
  });

  test('a run/ledger state is never mistaken for an undecided checklist item', () => {
    expect(pendingChecklist([item('x', 'awaiting_admin_decision')])).toEqual([]);
  });
});

describe('the drift panel — "nothing to compare" is not "no drift"', () => {
  test('a single snapshot says so, never that drift was checked and found clean', () => {
    const text = driftText({ signal: 'single_snapshot', from: '0.50.0.0', to: '0.50.5.0', diff: null });
    expect(text).toMatch(/nothing to compare/i);
    expect(text).not.toMatch(/no (capability )?drift/i);
  });

  test('a real comparison with nothing changed says no drift, distinctly', () => {
    const text = driftText({ signal: 'no_drift', from: '0.50.0.0', to: '0.50.5.0', diff: null });
    expect(text).toMatch(/no capability drift/i);
  });

  test('a real diff is summarized, not just flagged', () => {
    const text = driftText({
      signal: 'drift', from: '0.50.0.0', to: '0.50.5.0',
      diff: { versionChanged: true, toolsAdded: ['a', 'b'], toolsRemoved: [], adaptersAdded: [], adaptersRemoved: [], profilesChanged: false },
    });
    expect(text).toContain('+2 tools');
  });
});

describe('the honest absence — D1', () => {
  test('the commands name the real target version once one is known, no placeholder button', () => {
    expect(planCommand('0.50.5.0')).toBe('bun run scripts/upgrade.ts plan --to 0.50.5.0');
    expect(runCommand('0.50.5.0')).toBe('bun run scripts/upgrade.ts run --to 0.50.5.0');
  });
});

const orig = globalThis.fetch;
afterEach(() => { globalThis.fetch = orig; });

const capture = (status = 200, body: unknown = {}) => {
  const seen: { url: string; method: string } = { url: '', method: '' };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.url = url; seen.method = init?.method ?? 'GET';
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return seen;
};

describe('the upgrade api client', () => {
  test('available and list address their own resources', async () => {
    const a = capture(200, { current_version: '0.50.0.0' });
    await upgradeApi.available();
    expect(a.url).toBe('/api/upgrades/available');

    const l = capture(200, { runs: [] });
    await upgradeApi.list();
    expect(l.url).toBe('/api/upgrades');
  });

  test('drift carries both versions as query params', async () => {
    const seen = capture(200, { signal: 'no_drift' });
    await upgradeApi.drift('0.50.0.0', '0.50.5.0');
    expect(seen.url).toBe('/api/upgrades/drift?from=0.50.0.0&to=0.50.5.0');
  });

  // The route returns `detectUpdate`'s classified envelope (camelCase + a
  // `status`), not upstream's raw check-update body the plan's sample assumed.
  // This pins the adapter to the executed shape.
  test('available maps the route\'s classified envelope into the banner view', async () => {
    capture(200, {
      status: 'available', error: null, currentVersion: '0.50.0.0',
      candidateVersion: '0.50.5.0', changelog: null, releaseUrl: null,
    });
    const d = await upgradeApi.available();
    expect(d.current_version).toBe('0.50.0.0');
    expect(d.latest_version).toBe('0.50.5.0');
    expect(d.update_available).toBe(true);
  });

  // `driftBetween` throws on a single snapshot and the route turns that into a
  // 400. The catch must map it to `single_snapshot`, never let it collapse into
  // the clean-comparison sentence.
  test('a route refusal is "nothing to compare", never "no drift"', async () => {
    capture(400, { error: 'capability drift needs a recorded snapshot at BOTH versions; only 0.50.0.0 has one' });
    const d = await upgradeApi.drift('0.50.0.0', '0.50.5.0');
    expect(d.signal).toBe('single_snapshot');
    expect(driftText(d)).toMatch(/nothing to compare/i);
    expect(driftText(d)).not.toMatch(/no (capability )?drift/i);
  });

  test('ack and decline are distinct POSTs to distinct resources', async () => {
    const a = capture(200, { item: {} });
    await upgradeApi.ack('item1');
    expect(a.url).toBe('/api/upgrades/checklist/item1/ack');
    expect(a.method).toBe('POST');

    const d = capture(200, { item: {} });
    await upgradeApi.decline('item1');
    expect(d.url).toBe('/api/upgrades/checklist/item1/decline');
    expect(d.method).toBe('POST');
  });

  test('the generic client is still the one doing the work', () => {
    expect(typeof api.get).toBe('function');
  });
});
