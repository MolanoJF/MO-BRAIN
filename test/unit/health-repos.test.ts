import { test, expect, describe } from 'bun:test';
import { reposFromSourcesStatus } from '../../src/control/routes/health.ts';

describe('reposFromSourcesStatus', () => {
  // Would have failed against Array.isArray(r.json) ? r.json : [] — the
  // envelope is an object, so the old path always yielded [].
  test('unwraps sources from the status envelope object', () => {
    const envelope = {
      schema_version: 1,
      generated_at: '2026-09-15T00:00:00Z',
      sources: [{ id: 'shared' }, { id: 'customers' }],
    };
    expect(Array.isArray(envelope) ? envelope : []).toEqual([]);
    expect(reposFromSourcesStatus(envelope)).toEqual([
      { id: 'shared' },
      { id: 'customers' },
    ]);
  });

  test('passes through a bare array', () => {
    expect(reposFromSourcesStatus([{ id: 'shared' }])).toEqual([{ id: 'shared' }]);
  });

  test('empty / missing / non-array sources yields []', () => {
    expect(reposFromSourcesStatus(null)).toEqual([]);
    expect(reposFromSourcesStatus({})).toEqual([]);
    expect(reposFromSourcesStatus({ sources: 'nope' })).toEqual([]);
  });
});
