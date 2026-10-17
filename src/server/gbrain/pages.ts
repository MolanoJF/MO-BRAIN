import { parse } from 'yaml';
import type { McpCaller } from './mcp.ts';

// Argument and field names, as recorded by probe P7. Change them here only.
// list_pages/get_page filter is source_id. prefix is ignored by gbrain. search's source name was not recorded.
const A = { sourceId: 'source_id', limit: 'limit', offset: 'offset', slug: 'slug', includeContent: 'include_content', query: 'query', searchSource: 'source' };
const rowSource = (r: Record<string, unknown>) => (r.source_id ?? r.source ?? r.sourceId ?? null) as string | null;

export type PageRow = { slug: string; source: string | null; title: string | null; type: string | null; frontmatter: Record<string, unknown> | null };
export type Page = { slug: string; source: string | null; frontmatter: Record<string, unknown>; body: string; raw: Record<string, unknown> };
export type Hit = { slug: string; source: string | null; title: string | null; snippet: string | null };

export function frontmatterOf(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!m) return { frontmatter: {}, body: content };
  try { return { frontmatter: (parse(m[1]!) ?? {}) as Record<string, unknown>, body: m[2]! }; }
  catch { return { frontmatter: {}, body: content }; }
}

function rows(reply: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(reply)) return reply as Record<string, unknown>[];
  const r = reply as Record<string, unknown>;
  return (r?.[key] ?? r?.items ?? []) as Record<string, unknown>[];
}

const PAGE = 200;

/** One source, every page. `limit` is the page size. Probe P7: `prefix` is ignored; stop when a page is short. */
export async function listPages(call: McpCaller, q: { prefix?: string; source: string; limit?: number }): Promise<PageRow[]> {
  const limit = q.limit ?? PAGE;
  const listed: PageRow[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = rows(await call('list_pages', { [A.sourceId]: q.source, [A.limit]: limit, [A.offset]: offset }), 'pages').map((r) => ({
      slug: String(r.slug),
      source: rowSource(r),
      title: (r.title as string) ?? null,
      type: (r.type ?? null) as string | null,
      frontmatter: null,
    }));
    listed.push(...page);
    if (page.length < limit) break;
  }
  return q.prefix ? listed.filter((row) => row.slug.startsWith(q.prefix!)) : listed;
}

/**
 * The page's frontmatter: the reply's own `frontmatter` object under the `---`
 * fence in `content`, which wins per key.
 *
 * The reply's `frontmatter` is not the fence — it carries only what gbrain did
 * not lift into columns. Measured live on 0.60.230.0, a page whose fence held
 * `type`, `title`, `tags` and `trust_tier` came back with `{"trust_tier": ...}`
 * alone, so preferring it loses the title and type a reader sees.
 */
function pageFrontmatter(reply: Record<string, unknown>, content: string): Record<string, unknown> {
  const record = (reply.frontmatter && typeof reply.frontmatter === 'object') ? reply.frontmatter as Record<string, unknown> : {};
  return { ...record, ...frontmatterOf(content).frontmatter };
}

export async function getPage(call: McpCaller, source: string | null, slug: string): Promise<Page> {
  const args: Record<string, unknown> = { [A.slug]: slug, [A.includeContent]: true };
  if (source) args[A.sourceId] = source;
  const r = (await call('get_page', args)) as Record<string, unknown>;
  const content = String(r.content ?? r.compiled_truth ?? '');
  const parsed = frontmatterOf(content);
  return { slug, source: rowSource(r) ?? source, frontmatter: pageFrontmatter(r, content), body: parsed.body, raw: r };
}

export async function searchPages(call: McpCaller, query: string, source?: string): Promise<Hit[]> {
  const args: Record<string, unknown> = { [A.query]: query };
  if (source) args[A.searchSource] = source;
  args[A.limit] = 30;
  return rows(await call('search', args), 'results').map((r) => ({
    slug: String(r.slug), source: rowSource(r), title: (r.title as string) ?? null, snippet: (r.snippet ?? r.chunk_text ?? null) as string | null,
  }));
}
