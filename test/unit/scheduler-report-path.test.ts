import { test, expect, describe } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportRelPath, resolveReportTarget } from '../../src/ops/reports.ts';

describe('report paths follow upstream\'s convention', () => {
  test('reports/<job>/<stamp>.md, exactly', () => {
    expect(reportRelPath('live-sync', '2026-09-15-0230'))
      .toBe('reports/live-sync/2026-09-15-0230.md');
  });

  test('a job name that is not slug-shaped is refused, not sanitized', () => {
    for (const bad of ['../escape', 'a/b', 'Live Sync', '', '.hidden', 'x'.repeat(64)]) {
      expect(() => reportRelPath(bad, '2026-09-15-0230')).toThrow(/job name/);
    }
  });

  test('a stamp that is not the fixed shape is refused', () => {
    for (const bad of ['2026-09-15', '../../etc/passwd', '2026-09-15-0230.md', '']) {
      expect(() => reportRelPath('live-sync', bad)).toThrow(/stamp/);
    }
    // The DST second-pass suffix IS valid.
    expect(reportRelPath('live-sync', '2026-11-01-0130-2'))
      .toBe('reports/live-sync/2026-11-01-0130-2.md');
  });
});

describe('report target resolution never overwrites', () => {
  test('an unused path is returned as-is', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-reports-'));
    await mkdir(join(root, 'space-a'), { recursive: true });
    const t = await resolveReportTarget(root, 'space-a', 'live-sync', '2026-09-15-0230');
    expect(t.relPath).toBe('reports/live-sync/2026-09-15-0230.md');
  });

  test('an occupied path gets -2, then -3 — never a silent overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-reports-'));
    const dir = join(root, 'space-a', 'reports', 'live-sync');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '2026-09-15-0230.md'), 'first', 'utf8');
    const second = await resolveReportTarget(root, 'space-a', 'live-sync', '2026-09-15-0230');
    expect(second.relPath).toBe('reports/live-sync/2026-09-15-0230-2.md');

    await writeFile(join(dir, '2026-09-15-0230-2.md'), 'second', 'utf8');
    const third = await resolveReportTarget(root, 'space-a', 'live-sync', '2026-09-15-0230');
    expect(third.relPath).toBe('reports/live-sync/2026-09-15-0230-3.md');
  });

  test('a traversing sourceId is refused before any filesystem call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-reports-'));
    await expect(resolveReportTarget(root, '../etc', 'live-sync', '2026-09-15-0230'))
      .rejects.toThrow(/sourceId/);
  });
});
