import { useEffect, useMemo, useState } from 'react';
import { api, type Me, type Source } from '../api.ts';
import { buildTree, encodeSlug, pageSlugFromPath, type TreeNode } from '../lib.ts';
import { renderMarkdown } from '../markdown.ts';
import { interceptLinks, navigate } from '../router.ts';
import { Badge, Card, Empty, Input, Notice, PageTitle, Select, Spinner } from '../ui/index.tsx';

type PageRow = { slug: string; title: string | null; type: string | null };
type Hit = { slug: string; title: string | null; snippet: string | null };
type Page = { slug: string; frontmatter: Record<string, unknown>; body: string };

function Tree({ nodes, source, current }: { nodes: TreeNode[]; source: string; current: string | null }) {
  return (
    <ul className="ml-2 border-l border-border pl-2 text-sm">
      {nodes.map((n) => n.children ? (
        <li key={`d-${n.name}`}>
          <details open={current?.startsWith(`${n.name}/`) ?? false}>
            <summary className="cursor-pointer py-0.5 text-muted">{n.name}/</summary>
            <Tree nodes={n.children} source={source} current={current?.split('/').slice(1).join('/') ?? null} />
          </details>
        </li>
      ) : (
        <li key={`p-${n.slug}`}>
          <a href={`/pages/${encodeSlug(source)}/${encodeSlug(n.slug!)}`} className={`block truncate py-0.5 ${current === n.name ? 'font-semibold' : ''}`}>{n.name}</a>
        </li>
      ))}
    </ul>
  );
}

export function Pages({ me: _me, path }: { me: Me; path: string }) {
  const m = /^\/pages(?:\/([^/]+)(?:\/(.+))?)?$/.exec(path);
  const [sources, setSources] = useState<Source[] | null>(null);
  const source = m?.[1] ?? sources?.[0]?.id ?? null;
  const slug = pageSlugFromPath(path);
  const [rows, setRows] = useState<PageRow[] | null>(null);
  const [q, setQ] = useState(''); const [hits, setHits] = useState<Hit[] | null>(null);
  const [page, setPage] = useState<Page | null>(null); const [error, setError] = useState<string | null>(null);

  useEffect(() => { api<{ sources: Source[] }>('/api/sources').then((r) => setSources(r.sources)); }, []);
  useEffect(() => {
    if (!source) return;
    setRows(null);
    api<{ pages: PageRow[] }>(`/api/pages?source=${source}`).then((r) => setRows(r.pages), (e) => setError(String(e.message)));
  }, [source]);
  useEffect(() => {
    if (!source || !slug) { setPage(null); return; }
    api<Page>(`/api/pages/${encodeSlug(source)}/${encodeSlug(slug)}`).then(setPage, () => setPage({ slug, frontmatter: {}, body: '_This page could not be loaded._' }));
  }, [source, slug]);
  useEffect(() => {
    if (!source || q.trim().length < 2) { setHits(null); return; }
    const t = setTimeout(() => api<{ hits: Hit[] }>(`/api/pages?source=${source}&q=${encodeURIComponent(q)}`).then((r) => setHits(r.hits)), 250);
    return () => clearTimeout(t);
  }, [q, source]);

  const tree = useMemo(() => buildTree((rows ?? []).map((r) => r.slug)), [rows]);
  if (sources === null) return <Spinner />;
  if (sources.length === 0) return <Empty>No sources you can read yet.</Empty>;

  return (
    <div className="flex gap-6" onClick={interceptLinks}>
      <div className="flex w-72 shrink-0 flex-col gap-3">
        <Select value={source ?? ''} onChange={(e) => navigate(`/pages/${e.target.value}`)}>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}{s.kind === 'company' ? ' (company)' : ''}</option>)}
        </Select>
        <Input placeholder="Search this source" value={q} onChange={(e) => setQ(e.target.value)} />
        {hits ? (
          <ul className="text-sm">{hits.map((h) => (
            <li key={h.slug} className="py-1"><a href={`/pages/${encodeSlug(source!)}/${encodeSlug(h.slug)}`}>{h.title ?? h.slug}</a>
              {h.snippet && <div className="truncate text-muted">{h.snippet}</div>}</li>))}
            {hits.length === 0 && <Empty>No matches.</Empty>}</ul>
        ) : rows === null ? <Spinner /> : <Tree nodes={tree} source={source!} current={slug} />}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
      <div className="min-w-0 flex-1">
        {page ? (
          <>
            <PageTitle>{String(page.frontmatter.title ?? page.slug)}</PageTitle>
            <div className="mb-4 flex flex-wrap gap-2 text-sm text-muted">
              <code>{page.slug}</code>
              {typeof page.frontmatter.type === 'string' && <Badge>{page.frontmatter.type}</Badge>}
            </div>
            <article className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(page.body, source!) }} />
            {Object.keys(page.frontmatter).length > 0 && (
              <Card title="Frontmatter" className="mt-6">
                <pre className="overflow-x-auto text-sm">{JSON.stringify(page.frontmatter, null, 2)}</pre>
              </Card>
            )}
          </>
        ) : <Empty>Pick a page on the left, or search.</Empty>}
      </div>
    </div>
  );
}
