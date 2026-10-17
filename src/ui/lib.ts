import { ApiError } from './api.ts';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type Mode = 'personal' | 'company';

/** [[slug]], [[slug|label]], [[slug#anchor]] -> Markdown links into the same source. Code spans are left alone. */
export function wikiToLinks(md: string, source: string): string {
  return md.split(/(`[^`]*`)/).map((part) => part.startsWith('`') ? part
    : part.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, slug: string, label?: string) => {
        const s = slug.trim();
        return `[${(label ?? s).trim()}](/pages/${source}/${s})`;
      })).join('');
}

export type TreeNode = { name: string; slug?: string; children?: TreeNode[] };

/**
 * A page slug as it must appear inside a URL path: the `/` separators stay,
 * every other character is escaped.
 *
 * Both an `href` and a `fetch` want this form. A slug is page content, so it can
 * hold a space, a `?` or a `%`, and interpolating it raw turns the rest of the
 * URL into a query string or, worse, into an escape the server rejects.
 */
export function encodeSlug(slug: string): string {
  return slug.split('/').map(encodeURIComponent).join('/');
}

/**
 * The page slug in a `/pages/<source>/<slug>` path, decoded back to the slug
 * gbrain stores. `null` when the path names no page — the picker root, a
 * source with no page selected, a non-Pages route — or when the escape is
 * malformed.
 *
 * The malformed case is why this is a function and not a `decodeURIComponent`
 * call at the call site: `decodeURIComponent('%zz')` throws `URIError`, and a
 * throw during render is a blank console that re-blanks on every reload, since
 * the bad URL is still the URL. Nothing above a page can catch it — there is no
 * error boundary in this SPA — so the escape has to fail into a value, not a
 * throw.
 */
export function pageSlugFromPath(path: string): string | null {
  const raw = /^\/pages\/[^/]+\/(.+)$/.exec(path)?.[1];
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch { return null; }
}

export function buildTree(slugs: string[]): TreeNode[] {
  const root: TreeNode = { name: '', children: [] };
  for (const slug of slugs) {
    const parts = slug.split('/');
    let node = root;
    parts.forEach((name, i) => {
      const leaf = i === parts.length - 1;
      node.children ??= [];
      let next = node.children.find((c) => c.name === name && (leaf ? c.slug !== undefined : c.children !== undefined));
      if (!next) { next = leaf ? { name, slug } : { name, children: [] }; node.children.push(next); }
      node = next;
    });
  }
  const sort = (ns: TreeNode[]): TreeNode[] => ns
    .sort((a, b) => (a.children ? 0 : 1) - (b.children ? 0 : 1) || a.name.localeCompare(b.name))
    .map((n) => (n.children ? { ...n, children: sort(n.children) } : n));
  return sort(root.children ?? []);
}

export type NavEntry = { path: string; label: string };

export function navFor(role: Role, mode: Mode): NavEntry[] {
  const out: NavEntry[] = [
    { path: '/pages', label: 'Pages' },
    { path: '/sources', label: 'Sources' },
    { path: '/schema', label: 'Schema' },
  ];
  if (role === 'owner' || role === 'admin') out.push({ path: '/activity', label: 'Activity' }, { path: '/health', label: 'Health' });
  // Owners see People & access in both modes (it holds the mode switch); admins only manage people in company mode.
  if (role === 'owner' || (role === 'admin' && mode === 'company')) out.push({ path: '/people', label: 'People & access' });
  out.push({ path: '/connect', label: 'Connect your agent' });
  return out;
}

/**
 * The fields gbrain's `sources_status` reports for one source, measured from
 * probe P5's `sources_list` sample: the id and name, how many pages it holds,
 * whether it is federated, and when it last synced. Every field is optional
 * because the reply is gbrain's, not ours, and the console must not invent one.
 */
export type SourceStatus = {
  id?: string; name?: string; federated?: boolean; page_count?: number | null; last_sync_at?: string | null;
};

/**
 * One line for a source card: what gbrain knows about the source, or that it
 * said nothing usable — `error` is the failed fetch's message, when there was
 * one. A source whose record is present but carries none of the counters reads
 * as unavailable too, rather than as "0 pages", which would be a fact gbrain
 * never stated.
 */
export function sourceStatusLine(s: SourceStatus | null, error?: string | null): string {
  const bits: string[] = [];
  if (typeof s?.page_count === 'number') bits.push(`${s.page_count} page${s.page_count === 1 ? '' : 's'}`);
  if (s?.last_sync_at) bits.push(`last sync ${ago(s.last_sync_at)}`);
  if (s?.federated) bits.push('federated');
  if (bits.length) return `gbrain: ${bits.join(' · ')}`;
  return error ? `gbrain status unavailable (${error}).` : 'gbrain status unavailable.';
}

/**
 * The failed API call's code, as a sentence to show a person.
 *
 * The server answers with a machine code (`HttpError(409, 'user_inactive')`),
 * and rendering that verbatim is what the people page's review caught. The
 * sentences live here rather than in a page so the two pages that share these
 * flows — People & access and Connect your agent — say the same thing about the
 * same failure, and so the mapping is testable without a DOM.
 *
 * A code with no sentence is shown as itself: a bare `source_archived` still
 * names the problem, and inventing a generic "something went wrong" would hide
 * which one it was.
 */
const MESSAGES: Record<string, string> = {
  not_sole_member: 'Switch back only when you are the only person left.',
  company_mode_required: 'Switch to company mode first.',
  forbidden: 'You do not have permission for that.',
  user_exists: 'That person already has an account.',
  user_inactive: 'That person is being offboarded, so nothing can be changed.',
  name_required: 'Give the source a name.',
};

export function message(e: unknown): string {
  const code = e instanceof ApiError ? e.code : 'error';
  return MESSAGES[code] ?? code;
}

export function ago(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'never';
  const ms = now.getTime() - new Date(iso).getTime();
  const abs = Math.abs(ms); const future = ms < 0;
  const fmt = (n: number, u: string) => (future ? `in ${n}${u}` : `${n}${u} ago`);
  if (abs < 60_000) return future ? 'soon' : 'just now';
  if (abs < 3600_000) return fmt(Math.round(abs / 60_000), 'm');
  if (abs < 86400_000) return fmt(Math.round(abs / 3600_000), 'h');
  return fmt(Math.round(abs / 86400_000), 'd');
}
