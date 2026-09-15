import { test, expect, describe } from 'bun:test';
import { validateRequest, loadOperations } from '../../src/ops/dispatch.ts';

const ops = loadOperations();

describe('validateRequest', () => {
  test('accepts a registered operation with valid params', () => {
    expect(() => validateRequest(ops, { op: 'sources.list', params: {} })).not.toThrow();
  });

  // No passthrough: an operation not in operations.json cannot be reached,
  // however it is spelled (S2).
  test('rejects an unregistered operation', () => {
    expect(() => validateRequest(ops, { op: 'shell', params: {} }))
      .toThrow('unknown operation shell');
  });

  test('rejects an attempt to smuggle extra argv', () => {
    expect(() => validateRequest(ops, { op: 'sources.list', params: { _argv: ['rm -rf /'] } }))
      .toThrow('unknown param _argv');
  });

  test('rejects a non-scalar param value', () => {
    expect(() => validateRequest(ops, { op: 'config.set', params: { key: { a: 1 }, value: 'x' } }))
      .toThrow('param key must be a string, string[] or boolean');
  });

  test('rejects a missing required param', () => {
    expect(() => validateRequest(ops, { op: 'config.set', params: { key: 'search.mode' } }))
      .toThrow('missing required param value');
  });

  test('rejects --dry-run on an operation that does not support it', () => {
    expect(() => validateRequest(ops, { op: 'sources.list', params: {}, dryRun: true }))
      .toThrow('does not support --dry-run');
  });

  test('every loaded operation carries a privilege', () => {
    for (const spec of Object.values(ops)) {
      expect(['brain-db', 'read-only']).toContain(spec.privilege);
    }
  });
});
