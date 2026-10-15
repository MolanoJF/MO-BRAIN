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
