import { isFolder } from './schemaDraft.ts';
import { actorIdentity } from './actor.ts';
import { gitScaffold } from './opsClient.ts';

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

export type ScaffoldResult = {
  sourceId: string; pack: string | null; created: string[]; skipped: string[]; error: string | null;
};

/**
 * `effectivePack` and `resolveSourcePacks` live in `routes/schema.ts`, which
 * imports `scaffoldSpaces` from here. Passing them in keeps the import
 * one-directional (no module cycle) while still resolving each Space's pack
 * through gbrain's own resolver.
 */
type Deps = {
  resolveSourcePacks: (orgId: string) => Promise<{ sourceId: string; pack: string | null }[]>;
  effectivePack: (pack: string) => Promise<{ error: string | null } & Omit<ScaffoldSource, 'pack'>>;
};

/**
 * Scaffold every (or the named) Space from the pack THAT Space resolves: its
 * per-source stored intent, else the brain-wide pack (the same resolution the
 * Sources page shows). A Space whose pack failed to resolve reports the error
 * and is skipped, never scaffolded from a guess. Per-Space failures do not
 * abort the others.
 */
export async function scaffoldSpaces(
  orgId: string,
  userId: string,
  deps: Deps,
  sourceIds?: string[],
): Promise<ScaffoldResult[]> {
  const actor = await actorIdentity(userId);
  const spaces = (await deps.resolveSourcePacks(orgId))
    .filter((s) => !sourceIds || sourceIds.includes(s.sourceId));
  const results: ScaffoldResult[] = [];
  for (const s of spaces) {
    if (!s.pack) {
      results.push({ sourceId: s.sourceId, pack: null, created: [], skipped: [], error: 'no resolved pack' });
      continue;
    }
    const detail = await deps.effectivePack(s.pack);
    if (detail.error) {
      results.push({ sourceId: s.sourceId, pack: s.pack, created: [], skipped: [], error: detail.error });
      continue;
    }
    try {
      const r = await gitScaffold({
        sourceId: s.sourceId, actor, message: `scaffold: ${s.pack} folders`,
        entries: scaffoldEntries({ pack: s.pack, ...detail }),
      });
      results.push({ sourceId: s.sourceId, pack: s.pack, created: r.created, skipped: r.skipped, error: null });
    } catch (e) {
      results.push({
        sourceId: s.sourceId, pack: s.pack, created: [], skipped: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}
