// test/unit/ui-lib.test.ts
import { describe, expect, test } from 'bun:test';
import { ago, buildTree, navFor, wikiToLinks } from '../../src/ui/lib.ts';

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

describe('navFor', () => {
  test('members see review pages; owners and admins see activity, health and people', () => {
    expect(navFor('member', 'company').map((n) => n.path)).toEqual(['/pages', '/sources', '/schema', '/connect']);
    expect(navFor('owner', 'personal').map((n) => n.path)).toEqual(['/pages', '/sources', '/schema', '/activity', '/health', '/people', '/connect']);
    expect(navFor('admin', 'personal').map((n) => n.path)).not.toContain('/people');
    expect(navFor('admin', 'company').map((n) => n.path)).toContain('/people');
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
