import { isFolder } from './schemaDraft.ts';

export type ScaffoldSource = {
  pack: string;
  pageTypes: { name: string; primitive: string; pathPrefixes: string[]; aliases: string[]; extractable: boolean }[];
  filingRules: { kind: string; directory: string; description?: string | null }[];
  linkTypes: { name: string; inverse?: string | null; pageType?: string | null; targetType?: string | null }[];
};
export type ScaffoldEntry = { dir: string; readme: string };

const title = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * One folder per page type, from the EFFECTIVE manifest. The filing rule's
 * directory wins because that is where gbrain's own filing guidance tells
 * agents to put the type; otherwise it is the first folder-shaped prefix. A type
 * with neither gets no folder rather than a guessed one. Only paths matching
 * isFolder survive, so nothing a pack declares can steer a write outside the repo.
 *
 * README.md is in gbrain's SYNC_SKIP_FILES (S7 step 5), so the scaffold is
 * never imported as a page.
 */
export function scaffoldEntries(src: ScaffoldSource): ScaffoldEntry[] {
  const out: ScaffoldEntry[] = [];
  const seen = new Set<string>();
  for (const t of src.pageTypes) {
    const rule = src.filingRules.find((r) => r.kind === t.name && isFolder(r.directory));
    const dir = rule?.directory ?? t.pathPrefixes.find(isFolder);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const verbs = src.linkTypes.filter((l) => l.pageType === t.name || l.targetType === t.name);
    const lines = [
      `# ${title(t.name)}`,
      '',
      rule?.description ? `${rule.description}\n` : '',
      `Pages filed in this folder are typed \`${t.name}\` (primitive: ${t.primitive}) by the \`${src.pack}\` schema pack.`,
      t.pathPrefixes.length > 1 ? `\nAlso typed \`${t.name}\`: ${t.pathPrefixes.filter((p) => p !== dir).map((p) => `\`${p}\``).join(', ')}.` : '',
      t.aliases.length ? `\nAliases: ${t.aliases.join(', ')}.` : '',
      t.extractable ? '\nFacts are extracted from these pages.' : '',
      verbs.length ? `\n## Links\n\n${verbs.map((v) => `- \`${v.name}\`${v.pageType ? ` from ${v.pageType}` : ''}${v.targetType ? ` to ${v.targetType}` : ''}${v.inverse ? ` (inverse: \`${v.inverse}\`)` : ''}`).join('\n')}` : '',
      '',
      '_This README is folder scaffolding. gbrain does not index it as a page._',
      '',
    ];
    out.push({ dir, readme: lines.filter((l) => l !== '').join('\n') + '\n' });
  }
  return out;
}
