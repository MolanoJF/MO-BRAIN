import { test, expect, describe } from 'bun:test';
import { parsePurgeWriteThrough } from '../../src/contracts/receipts.ts';

// Exact literals measured from throwaway containers (inv-051-b): 0.50.5.0 and
// 0.51 emit different write-through vocabularies for the same synchronous
// unlink.
const RESIDUALS = 'Brain-repo git history, synced working-tree copies, exports, compiled context files and slug-keyed derived rows (takes, open loops, file records) may still hold the content - rotate the credential and rewrite or regenerate those copies.';

const PIN_050 = {
  status: 'purged',
  slug: 'runner-contract/revert-6d2d8c65',
  source_id: 'customers',
  write_through: { removed: true, path: '/data/repo/runner-contract/revert-6d2d8c65.md' },
  residuals: RESIDUALS,
};

const PIN_051 = {
  slug: 'runner-contract/revert-6d2d8c65',
  status: 'purged',
  source_id: 'customers',
  persistence: { mode: 'filesystem', git_state: 'queued', file_written: true },
  write_through: { written: true },
  residuals: RESIDUALS,
};

const PIN_051_NO_REPO = {
  status: 'purged',
  slug: 'runner-contract/revert-6d2d8c65',
  source_id: 'customers',
  write_through: { written: false, skipped: 'no_repo_configured' },
  residuals: RESIDUALS,
};

describe('parsePurgeWriteThrough', () => {
  test('0.50.5.0 reports the delete-specific removed/path pair', () => {
    expect(parsePurgeWriteThrough(PIN_050)).toEqual({
      removed: true,
      path: '/data/repo/runner-contract/revert-6d2d8c65.md',
    });
  });

  test('0.51 reports written plus persistence.file_written', () => {
    expect(parsePurgeWriteThrough(PIN_051)).toEqual({ written: true, fileWritten: true });
  });

  test('0.51 with no repo configured keeps written:false and drops skipped', () => {
    expect(parsePurgeWriteThrough(PIN_051_NO_REPO)).toEqual({ written: false });
  });

  test('a receipt with no write-through evidence is null', () => {
    expect(parsePurgeWriteThrough(null)).toBeNull();
    expect(parsePurgeWriteThrough(undefined)).toBeNull();
    expect(parsePurgeWriteThrough({})).toBeNull();
    expect(parsePurgeWriteThrough({ write_through: null })).toBeNull();
  });
});
