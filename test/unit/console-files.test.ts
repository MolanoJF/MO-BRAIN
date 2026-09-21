import { test, expect, describe } from 'bun:test';
import {
  fileKind, treeToNodes, accessNotice, spacePickerLabel, errorText,
  baseName, pathDepth, indentFor,
  canEdit, editToggleLabel, saveButtonLabel, saveSuccessText, saveFailureText,
  staleNotice, bypassVisible, isDirty, modeAfterSave, BYPASS_NOTICE,
  emptyStateText, treeErrorMessage, fileErrorMessage,
} from '../../src/console/pages/Files.tsx';
import {
  ApiError, encodePath, filesApi, type FileEntry, type FileSaveResult,
} from '../../src/console/api.ts';

/**
 * The console's Files lane. Every assertion here is a trust property rather
 * than a rendering detail: the tree an operator reads must be deterministic and
 * must not mutate the server's rows, the access notice must say plainly what
 * the operator may do, and a path must survive the URL round-trip without
 * losing its `/` separators. There is no DOM harness in this repo, so every
 * decision below is a pure function.
 */

const entry = (path: string, over: Partial<FileEntry> = {}): FileEntry => ({
  path,
  size: 0,
  isMarkdown: fileKind(path) === 'markdown',
  ...over,
});

describe('the file kind — markdown vs everything else', () => {
  // The tree's markdown marker must not depend on casing, and a near-miss
  // extension (`readme.md.bak`, a bare `md`) is NOT markdown.
  test('a markdown file is recognised case-insensitively', () => {
    for (const path of ['notes.md', 'NOTES.MD', 'page.markdown', 'Page.MarkDown']) {
      expect(fileKind(path)).toBe('markdown');
    }
  });

  test('a near miss is not markdown', () => {
    for (const path of ['notes.txt', 'md', 'readme.md.bak', 'notes.mdx', 'dir/markdown']) {
      expect(fileKind(path)).toBe('other');
    }
  });
});

describe('the file tree — deterministic and non-mutating', () => {
  // The server may hand the entries back in any order; the page sorts them so a
  // refresh cannot reshuffle the list under the operator.
  test('rows are sorted by path', () => {
    const nodes = treeToNodes([
      entry('z.md'),
      entry('a/b.md'),
      entry('a.md'),
      entry('a/a.md'),
    ]);
    expect(nodes.map((n) => n.path)).toEqual(['a.md', 'a/a.md', 'a/b.md', 'z.md']);
  });

  // Depth is the directory level the row indents to; name is the basename, so
  // the JSX never has to split a path to render a label.
  test('depth comes from the separators and name from the basename', () => {
    const [deep] = treeToNodes([entry('reports/2026/briefing.md')]);
    expect(deep!.depth).toBe(2);
    expect(deep!.name).toBe('briefing.md');

    const [top] = treeToNodes([entry('top.md')]);
    expect(top!.depth).toBe(0);
    expect(top!.name).toBe('top.md');
  });

  test('baseName and pathDepth agree with the row they build', () => {
    expect(baseName('a/b/c.md')).toBe('c.md');
    expect(pathDepth('a/b/c.md')).toBe(2);
    expect(pathDepth('c.md')).toBe(0);
  });

  // The caller's array is data the page does not own: sorting it in place would
  // silently reorder a state array or a server payload held elsewhere.
  test('the input array is not mutated', () => {
    const input = [entry('z.md'), entry('a.md')];
    const snapshot = input.map((e) => e.path);
    const nodes = treeToNodes(input);
    expect(input.map((e) => e.path)).toEqual(snapshot);
    expect(nodes.map((n) => n.path)).toEqual(['a.md', 'z.md']);
    expect(input[0]!.path).toBe('z.md');
  });

  // The kind rides along from `fileKind`, so the tree and the badge cannot
  // disagree about what a file is.
  test('kind rides along from fileKind', () => {
    const nodes = treeToNodes([entry('a.md'), entry('b.txt')]);
    expect(nodes.find((n) => n.path === 'a.md')!.kind).toBe('markdown');
    expect(nodes.find((n) => n.path === 'b.txt')!.kind).toBe('other');
  });

  test('an empty tree is an empty list, not a placeholder row', () => {
    expect(treeToNodes([])).toEqual([]);
  });
});

describe('the access notice — plain words', () => {
  // read-only, can-edit and no-access are three different sentences, each
  // saying exactly what the operator may do.
  test('read, write and nothing are three distinct sentences', () => {
    const read = accessNotice('read');
    const write = accessNotice('write');
    const none = accessNotice(null);
    expect(new Set([read, write, none]).size).toBe(3);
    expect(read).toMatch(/read-only/i);
    expect(write).toMatch(/edit/i);
    expect(none).toMatch(/no access/i);
  });
});

describe('the admin bypass disclosure — Stage 2 copy locked now', () => {
  // The bypass notice is shown when an org admin edits a Space they have no
  // write Connection to. It must name the admin and must not leak internals
  // (route names, tokens, shas) into operator-facing copy.
  test('it exists, names an admin, and leaks no internals', () => {
    expect(BYPASS_NOTICE.length).toBeGreaterThan(0);
    expect(BYPASS_NOTICE).toMatch(/admin/i);
    expect(BYPASS_NOTICE).toMatch(/outside your Connections/i);
    expect(BYPASS_NOTICE).not.toMatch(/api|token|sha|sourceId|endpoint/i);
  });
});

describe('encodePath — segments encoded, separators kept', () => {
  // The route matches on `files/*`; a `%2F` for a `/` would address a single
  // segment and miss the file, so the separator must survive while every other
  // segment character is encoded.
  test('a nested path keeps its slashes and encodes each segment', () => {
    expect(encodePath('reports/2026/hello world.md')).toBe('reports/2026/hello%20world.md');
    expect(encodePath('top.md')).toBe('top.md');
  });

  test('reserved characters are encoded inside a segment', () => {
    expect(encodePath('a#b/c?d.md')).toBe('a%23b/c%3Fd.md');
    expect(encodePath('notes & drafts/x.md')).toBe('notes%20%26%20drafts/x.md');
  });
});

describe('plain strings and error text', () => {
  // The fallback strings are read by an operator; none of them may be empty.
  test('the fallback strings are non-empty', () => {
    for (const text of [emptyStateText, treeErrorMessage, fileErrorMessage]) {
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  // An error is a sentence, never a raw object: an ApiError keeps the server's
  // own words, an Error keeps its message, and anything else is the fallback.
  test('an ApiError and an Error render their message; anything else the fallback', () => {
    expect(errorText(new ApiError('Space not found', 404), 'fallback')).toBe('Space not found');
    expect(errorText(new Error('boom'), 'fallback')).toBe('boom');
    expect(errorText(new Error(''), 'fallback')).toBe('fallback');
    expect(errorText({ weird: true }, 'fallback')).toBe('fallback');
    expect(errorText(null, 'fallback')).toBe('fallback');
  });

  test('the picker label names the Space and disambiguates with its source id', () => {
    expect(spacePickerLabel({ id: '1', sourceId: 'shared', name: 'Shared', access: 'read' }))
      .toBe('Shared (shared)');
  });

  test('indentation never goes negative', () => {
    expect(indentFor(0)).toBe(0);
    expect(indentFor(3)).toBe(36);
    expect(indentFor(-1)).toBe(0);
  });
});

/**
 * Stage 2 — the save lane. The Edit gate, the dirty gate and every status
 * sentence are pure so they can be asserted here without a DOM. The stale
 * result is the load-bearing one: it is a CHOICE the operator makes, so the
 * copy must say the save wrote NOTHING rather than let a silent overwrite pass
 * as an error that "did not work".
 */

describe('the edit gate — only a write Connection may edit', () => {
  // `null` means nothing is selected yet, which is neither read nor write:
  // only `write` opens the editor.
  test('canEdit is true only for write', () => {
    expect(canEdit('write')).toBe(true);
    expect(canEdit('read')).toBe(false);
    expect(canEdit(null)).toBe(false);
  });

  // One toggle, two modes, two distinct labels — a label that did not change
  // would leave the operator unsure whether they entered edit mode.
  test('editToggleLabel is distinct for read and edit', () => {
    expect(editToggleLabel('read')).not.toBe(editToggleLabel('edit'));
    expect(editToggleLabel('read').length).toBeGreaterThan(0);
    expect(editToggleLabel('edit').length).toBeGreaterThan(0);
  });

  // The decision after a committed save is read mode, locked here.
  test('a committed save returns to read mode', () => {
    expect(modeAfterSave()).toBe('read');
  });
});

describe('the save button — pending and dirty are its two gates', () => {
  test('saveButtonLabel distinguishes pending from idle', () => {
    expect(saveButtonLabel(true)).not.toBe(saveButtonLabel(false));
    expect(saveButtonLabel(false).length).toBeGreaterThan(0);
  });

  // Dirty is baseline equality in both directions: a changed buffer is dirty,
  // and undoing back to the loaded text is clean again.
  test('isDirty compares the draft to the baseline', () => {
    expect(isDirty('a', 'a')).toBe(false);
    expect(isDirty('', '')).toBe(false);
    expect(isDirty('a', 'a ')).toBe(true);
    expect(isDirty('x', '')).toBe(true);
    expect(isDirty('', 'x')).toBe(true);
  });
});

describe('the save status — success, failure and the stale choice', () => {
  const committed = (bypass: boolean): FileSaveResult =>
    ({ committed: true, sha: 'abc123', bypass, index: null });
  const stale = (sha: string | null): FileSaveResult =>
    ({ committed: false, error: 'stale', sha, bypass: false });

  test('saveSuccessText names the commit sha', () => {
    expect(saveSuccessText('deadbeef')).toContain('deadbeef');
    expect(saveSuccessText('deadbeef').length).toBeGreaterThan(0);
  });

  test('saveFailureText carries the server sentence, never an empty one', () => {
    expect(saveFailureText('duplicate path')).toContain('duplicate path');
    expect(saveFailureText('').length).toBeGreaterThan(0);
  });

  // The stale notice is the whole point: it must say the file changed
  // elsewhere AND that the save wrote nothing, so nobody assumes an overwrite
  // happened. A null sha is the same notice with no version to name.
  test('staleNotice says the file changed and that nothing was written', () => {
    const withSha = staleNotice('newsha');
    expect(withSha).toMatch(/changed elsewhere/i);
    expect(withSha).toMatch(/wrote nothing/i);
    expect(withSha).toContain('newsha');

    const without = staleNotice(null);
    expect(without).toMatch(/changed elsewhere/i);
    expect(without).toMatch(/wrote nothing/i);
  });

  // Bypass is only ever disclosed on a committed save: a stale result wrote
  // nothing, so it cannot have edited outside the operator's Connections.
  test('bypassVisible is true only on a committed bypass', () => {
    expect(bypassVisible(committed(true))).toBe(true);
    expect(bypassVisible(committed(false))).toBe(false);
    expect(bypassVisible(stale('x'))).toBe(false);
    expect(bypassVisible(null)).toBe(false);
  });
});

describe('the save call — the PUT the page actually makes', () => {
  // Task 1's wire half: the encoded path keeps its `/` separators, the method
  // is PUT, and the body carries exactly the pinned three keys.
  test('filesApi.save PUTs the encoded path with content, expectedSha and message', async () => {
    const orig = globalThis.fetch;
    let seen = { url: '', method: '', body: '' };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen = { url, method: init?.method ?? '', body: String(init?.body) };
      return new Response(
        JSON.stringify({ committed: true, sha: 's', bypass: false, index: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    try {
      const result = await filesApi.save('shared', 'reports/hello world.md', {
        content: '# hi',
        expectedSha: 'old',
        message: 'edit',
      });
      expect(seen.url).toBe('/api/spaces/shared/files/reports/hello%20world.md');
      expect(seen.method).toBe('PUT');
      expect(JSON.parse(seen.body)).toEqual({ content: '# hi', expectedSha: 'old', message: 'edit' });
      expect(result).toEqual({ committed: true, sha: 's', bypass: false, index: null });
    } finally {
      globalThis.fetch = orig;
    }
  });
});
