export type PackFile = {
  name: string;
  version: string;
  extends: string | null;
  page_types: { name: string; primitive: string; path_prefixes?: string[]; aliases?: string[] }[];
  link_types?: { name: string }[];
};

export type CoreLockInput = {
  active: string | null;
  core: PackFile | null;
  personal: PackFile | null;
  brain: PackFile | null;
  installedHashes: Record<string, string | null>;
  expectedHashes: Record<string, string>;
};

export type CoreLockResult = { ok: boolean; problems: string[] };

/** Spec §6.3. Pure: the caller reads files and gbrain; this only judges. */
export function checkCoreLock(i: CoreLockInput): CoreLockResult {
  const problems: string[] = [];
  for (const [file, want] of Object.entries(i.expectedHashes)) {
    if (i.installedHashes[file] !== want) problems.push(`pack_modified:${file}`);
  }
  if (i.active !== 'mobrain-brain') problems.push(`active_pack:${i.active ?? 'none'}`);
  for (const [name, p] of [['mobrain-core', i.core], ['mobrain-personal', i.personal], ['mobrain-brain', i.brain]] as const) {
    if (!p) problems.push(`missing_pack:${name}`);
  }
  if (i.brain && i.brain.extends !== 'mobrain-personal') problems.push(`chain:mobrain-brain->${i.brain.extends ?? 'none'}`);
  if (i.personal && i.personal.extends !== 'mobrain-core') problems.push(`chain:mobrain-personal->${i.personal.extends ?? 'none'}`);

  if (i.brain) {
    const locked = [i.core, i.personal].filter((p): p is PackFile => p !== null);
    const types = new Set(locked.flatMap((p) => p.page_types.map((t) => t.name)));
    const aliases = new Set(locked.flatMap((p) => p.page_types.flatMap((t) => t.aliases ?? [])));
    const prefixes = new Set(locked.flatMap((p) => p.page_types.flatMap((t) => t.path_prefixes ?? [])));
    const links = new Set(locked.flatMap((p) => (p.link_types ?? []).map((l) => l.name)));
    for (const t of i.brain.page_types) {
      if (types.has(t.name)) problems.push(`shadowed_type:${t.name}`);
      for (const a of t.aliases ?? []) if (aliases.has(a) || types.has(a)) problems.push(`shadowed_alias:${a}`);
      for (const p of t.path_prefixes ?? []) if (prefixes.has(p)) problems.push(`shadowed_prefix:${p}`);
    }
    for (const l of i.brain.link_types ?? []) if (links.has(l.name)) problems.push(`shadowed_link_type:${l.name}`);
  }
  return { ok: problems.length === 0, problems };
}
