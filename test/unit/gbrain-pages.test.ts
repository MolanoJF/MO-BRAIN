// test/unit/gbrain-pages.test.ts
import { describe, expect, test } from 'bun:test';
import { frontmatterOf, getPage, listPages, searchPages } from '../../src/server/gbrain/pages.ts';
import type { McpCaller } from '../../src/server/gbrain/mcp.ts';

function recorder(reply: unknown) {
  const calls: [string, Record<string, unknown>][] = [];
  const call = (async (tool: string, args: Record<string, unknown>) => { calls.push([tool, args]); return reply; }) as McpCaller;
  return { calls, call };
}

describe('gbrain page helpers', () => {
  test('listPages filters with source_id and applies prefix locally', async () => {
    const { calls, call } = recorder({ pages: [
      { slug: 'a/b', source_id: 'p-x', title: 'B', type: 'note', updated_at: 't', updated_at_iso: 't' },
      { slug: 'notes/x', source_id: 'p-x', title: 'X', type: 'note' },
    ] });
    const rows = await listPages(call, { prefix: 'a/', source: 'p-x', limit: 10 });
    expect(calls).toEqual([['list_pages', { source_id: 'p-x', limit: 10, offset: 0 }]]);
    expect(rows).toEqual([{ slug: 'a/b', source: 'p-x', title: 'B', type: 'note', frontmatter: null }]);
  });

  test('listPages pages offset until a short page, then keeps the prefix', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const call = (async (_tool: string, args: Record<string, unknown>) => {
      calls.push(['list_pages', args]);
      if (args.offset === 0) return { pages: [
        { slug: 'notes/0', source_id: 'p-x', title: '0', type: 'note' },
        { slug: 'notes/1', source_id: 'p-x', title: '1', type: 'note' },
      ] };
      return { pages: [{ slug: 'system/collectors/mail', source_id: 'p-x', title: 'Mail', type: 'collector' }] };
    }) as McpCaller;
    const rows = await listPages(call, { prefix: 'system/collectors/', source: 'p-x', limit: 2 });
    expect(calls.map((c) => c[1].offset)).toEqual([0, 2]);
    expect(rows.map((r) => r.slug)).toEqual(['system/collectors/mail']);
  });

  test('getPage asks for include_content and source_id, and prefers the frontmatter object', async () => {
    const { calls, call } = recorder({
      slug: 's', source_id: 'p-x', type: 'collector',
      content: '---\ntype: collector\nkind: fixture\n---\nbody',
      frontmatter: { kind: 'fixture', cadence: '2h' },
    });
    const p = await getPage(call, 'p-x', 's');
    expect(calls[0]).toEqual(['get_page', { slug: 's', include_content: true, source_id: 'p-x' }]);
    expect(p.frontmatter).toEqual({ kind: 'fixture', cadence: '2h' });
    expect(p.body.trim()).toBe('body');
  });

  test('getPage reads frontmatter from content when the reply has none', async () => {
    const { call } = recorder({ slug: 's', source_id: 'p-x', content: '---\ntype: collector\ncadence: 2h\n---\nbody' });
    const p = await getPage(call, 'p-x', 's');
    expect(p.frontmatter).toEqual({ type: 'collector', cadence: '2h' });
    expect(p.body.trim()).toBe('body');
  });

  test('searchPages maps hits', async () => {
    const { calls, call } = recorder({ results: [{ slug: 'x', source_id: 'c-a', title: 'X', snippet: '…' }] });
    expect(await searchPages(call, 'zebra', 'c-a')).toEqual([{ slug: 'x', source: 'c-a', title: 'X', snippet: '…' }]);
    expect(calls[0]).toEqual(['search', { query: 'zebra', source: 'c-a', limit: 30 }]);
  });

  test('frontmatterOf tolerates a page without a fence', () => {
    expect(frontmatterOf('just text')).toEqual({ frontmatter: {}, body: 'just text' });
  });
});
