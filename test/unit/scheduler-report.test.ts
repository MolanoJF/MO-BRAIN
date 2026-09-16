import { test, expect, describe } from 'bun:test';
import { renderReport } from '../../src/scheduler/report.ts';

const base = {
  job: 'live-sync',
  scheduleId: 'sched-1',
  runId: 'run-1',
  slot: '2026-11-01T01:30#2',
  stamp: '2026-11-01-0130-2',
  timezone: 'America/New_York',
  fireAt: new Date(Date.UTC(2026, 10, 1, 6, 30)),
  startedAt: new Date(Date.UTC(2026, 10, 1, 6, 30, 1)),
  finishedAt: new Date(Date.UTC(2026, 10, 1, 6, 30, 4)),
  connection: { id: 'conn-1', clientName: 'bs-abc12345-shared', writeSpace: 'shared' },
  scope: 'source' as const,
  argv: ['gbrain', 'sync', '--source', 'shared', '--json'],
  exitCode: 0,
  classification: 'ok' as const,
  payload: { added: 2, modified: 1, deleted: 0 },
  stdout: 'Synced 3 files\n',
  stderr: '',
};

describe('report rendering', () => {
  test('leads with the facts an operator needs before any prose', () => {
    const md = renderReport(base);
    expect(md.startsWith('# live-sync — 2026-11-01-0130-2\n')).toBe(true);
    for (const needle of [
      'Slot: `2026-11-01T01:30#2`', 'Timezone: `America/New_York`',
      'Connection: `bs-abc12345-shared`', 'Write Space: `shared`',
      'Exit code: `0`', 'Result: `ok`',
    ]) expect(md).toContain(needle);
  });

  test('a brain-wide run carries the honesty banner', () => {
    const md = renderReport({ ...base, job: 'weekly-health', scope: 'brain-wide' });
    expect(md).toContain('reads the whole brain, not just');
  });

  test('argv is REDACTED, and secrets never reach the repo', () => {
    const md = renderReport({
      ...base,
      argv: ['gbrain', 'mcp', 'grant', 'x', '--url', 'https://u:p@example.test/mcp'],
      stdout: 'client_secret: abcdef123456\nkey sk-livekeyvalue1234\n',
      stderr: 'postgres://user:hunter2@postgres:5432/gbrain refused\n',
    });
    expect(md).not.toContain('hunter2');
    expect(md).not.toContain('abcdef123456');
    expect(md).not.toContain('sk-livekeyvalue1234');
    expect(md).toContain('***REDACTED***');
  });

  test('long output is capped so one bad run cannot bloat the repo', () => {
    const md = renderReport({ ...base, stdout: 'x'.repeat(50_000) });
    expect(md.length).toBeLessThan(12_000);
    expect(md).toContain('truncated');
  });

  test('a failed run shows the failure prominently and keeps stderr', () => {
    const md = renderReport({
      ...base, exitCode: 1, classification: 'conflict',
      payload: { status: 'push_failed', reason: 'non-fast-forward' },
      stderr: 'error: failed to push some refs\n',
    });
    expect(md).toContain('Result: `conflict`');
    expect(md).toContain('failed to push some refs');
    expect(md).toContain('non-fast-forward');
  });
});
