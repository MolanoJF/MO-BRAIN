import { describe, expect, test } from 'bun:test';
import {
  doneText, gitUrlError, prefixError, previewText, redactionSummary, skipSummary, stripTopFolder,
} from '../../src/console/ImportPanel.tsx';
import type { ImportNotesResult } from '../../src/console/api.ts';

const result = (over: Partial<ImportNotesResult> = {}): ImportNotesResult => ({
  ok: true, from: 'github.com/acme/notes',
  plan: { kept: 744, skipped: [], redactions: [], totalBytes: 4_600_000, estTokens: 1_150_000 },
  added: 744, updated: 0, unchanged: 0, sha: 'abcdef1234567', estUsd: 0.023,
  index: { sync: { exitCode: 0, classification: 'ok' }, embed: { exitCode: 0, classification: 'ok' } },
  sourceStatus: { pages: 744, chunks: 3000, embeddedChunks: 3000, coveragePct: 100 },
  ...over,
});

describe('import panel copy', () => {
  test('skips are grouped by reason, largest first', () => {
    expect(skipSummary([{ reason: 'not_markdown' }, { reason: 'hidden' }, { reason: 'hidden' }]))
      .toBe('3 skipped: 2 hidden, 1 not Markdown');
    expect(skipSummary([])).toBeNull();
  });

  test('redactions count secrets and files, and name the kinds', () => {
    expect(redactionSummary([
      { path: 'a.md', kind: 'anthropic-key', count: 2 },
      { path: 'b.md', kind: 'github-token', count: 1 },
    ])).toBe('3 secrets redacted in 2 files (anthropic-key, github-token)');
    expect(redactionSummary([])).toBeNull();
  });

  test('the preview names pages, changes and the embedding estimate', () => {
    expect(previewText(result({ dryRun: true, sha: null })))
      .toBe('744 pages from github.com/acme/notes (744 new). Embedding them costs about $0.02.');
    expect(previewText(result({ estUsd: 0.001, added: 1, unchanged: 2, plan: { ...result().plan, kept: 3 } })))
      .toBe('3 pages from github.com/acme/notes (1 new, 2 already here). Embedding them costs about $0.01 or less.');
    expect(previewText(result({ estUsd: null }))).not.toContain('$');
  });

  test('done says what the brain holds, and never hides an index that did not move', () => {
    expect(doneText(result())).toEqual({
      tone: 'ok',
      text: 'Imported 744 pages from github.com/acme/notes (commit abcdef1). The brain now holds 744 pages, 100% embedded.',
    });
    expect(doneText(result({ index: { sync: { exitCode: 0, classification: 'ok' }, embed: { exitCode: 3, classification: 'failed' } } })).tone)
      .toBe('warning');
    expect(doneText(result({ index: { sync: { exitCode: 1, classification: 'failed' }, embed: null } })).text)
      .toContain('sync exit 1');
    expect(doneText(result({ sha: null })).text).toContain('already here');
  });

  test('a git URL must be https and name a repo, with no credentials', () => {
    expect(gitUrlError('https://github.com/acme/notes.git')).toBeNull();
    expect(gitUrlError('git@github.com:acme/notes.git')).not.toBeNull();
    expect(gitUrlError('http://github.com/acme/notes')).toMatch(/https/);
    expect(gitUrlError('https://user:tok@github.com/acme/notes')).toMatch(/credentials/);
    expect(gitUrlError('https://github.com/')).toMatch(/name a repository/);
  });

  test('a prefix is a plain folder path', () => {
    expect(prefixError('')).toBeNull();
    expect(prefixError('notes/vault')).toBeNull();
    expect(prefixError('../up')).not.toBeNull();
  });

  test('the chosen folder name becomes the label, its contents the paths', () => {
    expect(stripTopFolder('vault/people/ana.md')).toEqual({ top: 'vault', path: 'people/ana.md' });
    expect(stripTopFolder('loose.md')).toEqual({ top: '', path: 'loose.md' });
  });
});
