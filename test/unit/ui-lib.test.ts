// test/unit/ui-lib.test.ts
import { describe, expect, test } from 'bun:test';
import { ApiError } from '../../src/ui/api.ts';
import { ago, buildTree, encodeSlug, message, navFor, pageSlugFromPath, sourceStatusLine, wikiToLinks } from '../../src/ui/lib.ts';

describe('wikiToLinks', () => {
  test('plain, labelled and anchored wiki links become app links in the same source', () => {
    expect(wikiToLinks('See [[people/ada]] and [[companies/acme|Acme]] and [[notes/x#part]].', 'p-own'))
      .toBe('See [people/ada](/pages/p-own/people/ada) and [Acme](/pages/p-own/companies/acme) and [notes/x](/pages/p-own/notes/x).');
  });
  test('leaves code spans alone', () => {
    expect(wikiToLinks('`[[raw]]`', 'p')).toBe('`[[raw]]`');
  });
});

describe('buildTree', () => {
  test('folders first, sorted, with pages as leaves', () => {
    const t = buildTree(['people/ada', 'people/bob', 'readme', 'companies/acme/team']);
    expect(t.map((n) => n.name)).toEqual(['companies', 'people', 'readme']);
    expect(t[0]!.children!.map((n) => n.name)).toEqual(['acme']);
    expect(t[1]!.children!.map((n) => n.slug)).toEqual(['people/ada', 'people/bob']);
  });
});

describe('pageSlugFromPath', () => {
  test('decodes a page slug, and reports no slug for the routes that have none', () => {
    expect(pageSlugFromPath('/pages/p-own/people/ada')).toBe('people/ada');
    expect(pageSlugFromPath('/pages/p-own/notes/a%20b')).toBe('notes/a b');
    expect(pageSlugFromPath('/pages/p-own')).toBeNull();
    expect(pageSlugFromPath('/pages')).toBeNull();
    expect(pageSlugFromPath('/sources')).toBeNull();
  });

  // A malformed escape is reachable from the address bar alone, and
  // `decodeURIComponent` throws on it. The throw happened during render, so the
  // whole SPA blanked — and re-blanked on reload, because the URL was unchanged.
  test('a malformed escape returns null instead of throwing', () => {
    expect(() => pageSlugFromPath('/pages/p-own/%zz')).not.toThrow();
    expect(pageSlugFromPath('/pages/p-own/%zz')).toBeNull();
    expect(pageSlugFromPath('/pages/p-own/100%')).toBeNull();
  });
});

describe('encodeSlug', () => {
  test('escapes each segment and keeps the separators', () => {
    expect(encodeSlug('people/ada')).toBe('people/ada');
    expect(encodeSlug('notes/a b?c')).toBe('notes/a%20b%3Fc');
  });

  test('round-trips through pageSlugFromPath', () => {
    const slug = 'notes/100% done';
    expect(pageSlugFromPath(`/pages/p-own/${encodeSlug(slug)}`)).toBe(slug);
  });
});

describe('sourceStatusLine', () => {
  test('states page count, sync age and federation', () => {
    const iso = '2026-10-14T09:00:00Z';
    expect(sourceStatusLine({ page_count: 3, last_sync_at: iso, federated: true }))
      .toBe(`gbrain: 3 pages · last sync ${ago(iso)} · federated`);
    expect(sourceStatusLine({ page_count: 1 })).toBe('gbrain: 1 page');
    expect(sourceStatusLine({ id: 'p-own', name: 'Mine' })).toBe('gbrain status unavailable.');
    expect(sourceStatusLine(null)).toBe('gbrain status unavailable.');
    expect(sourceStatusLine(null, 'http_500')).toBe('gbrain status unavailable (http_500).');
  });
});

describe('navFor', () => {
  test('members see review pages; owners and admins see activity, health and people', () => {
    expect(navFor('member', 'company').map((n) => n.path)).toEqual(['/pages', '/sources', '/schema', '/connect']);
    expect(navFor('owner', 'personal').map((n) => n.path)).toEqual(['/pages', '/sources', '/schema', '/activity', '/health', '/people', '/connect']);
    expect(navFor('admin', 'personal').map((n) => n.path)).not.toContain('/people');
    expect(navFor('admin', 'company').map((n) => n.path)).toContain('/people');
  });
});

describe('message', () => {
  test('turns an API code into the sentence the page shows', () => {
    expect(message(new ApiError(403, 'forbidden'))).toBe('You do not have permission for that.');
    expect(message(new ApiError(409, 'user_exists'))).toBe('That person already has an account.');
    expect(message(new ApiError(400, 'name_required'))).toBe('Give the source a name.');
    expect(message(new ApiError(409, 'user_inactive'))).toBe('That person is being offboarded, so nothing can be changed.');
  });

  // A code with no sentence shows as itself — a bare `source_archived` still
  // names the problem — and a failure that is not an API reply at all (a
  // dropped connection rejects with a TypeError) has no code to show.
  test('falls back to the code, then to `error`', () => {
    expect(message(new ApiError(409, 'source_archived'))).toBe('source_archived');
    expect(message(new TypeError('Failed to fetch'))).toBe('error');
  });
});

describe('ago', () => {
  test('formats relative time', () => {
    const now = new Date('2026-10-14T12:00:00Z');
    expect(ago('2026-10-14T11:59:30Z', now)).toBe('just now');
    expect(ago('2026-10-14T11:15:00Z', now)).toBe('45m ago');
    expect(ago('2026-10-14T09:00:00Z', now)).toBe('3h ago');
    expect(ago('2026-10-12T12:00:00Z', now)).toBe('2d ago');
    expect(ago('2026-10-14T13:00:00Z', now)).toBe('in 1h');
    expect(ago(null, now)).toBe('never');
  });
});
