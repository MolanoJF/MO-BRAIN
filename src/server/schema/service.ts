import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { lastJson, type CliResult } from '../gbrain/cli.ts';
import { checkCoreLock, type CoreLockInput, type CoreLockResult, type PackFile } from './coreLock.ts';

type Cli = (argv: string[], opts?: { timeoutMs?: number }) => Promise<CliResult>;
export type SchemaPaths = { packsDir: string; gbrainHome: string; cli: Cli };

const LAYERS = [['core', 'mobrain-core', 'mobrain-core.json'], ['personal', 'mobrain-personal', 'mobrain-personal.json'], ['brain', 'mobrain-brain', null]] as const;

async function readJson(path: string): Promise<{ text: string; json: unknown } | null> {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  const text = await f.text();
  try { return { text, json: JSON.parse(text) }; } catch { return null; }
}

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

export async function activePackName(cli: Cli): Promise<string | null> {
  const r = await cli(['schema', 'active', '--json'], { timeoutMs: 20_000 });
  if (r.exitCode !== 0) return null;
  const j = lastJson(r.stdout) as Record<string, unknown> | null;
  // Probe: `schema active --json` sets `pack` to a string. Object `pack.name` stays a fallback.
  const pack = j?.pack;
  const packName = typeof pack === 'string' ? pack : (pack as Record<string, unknown> | undefined)?.name;
  const pick = j?.name ?? j?.pack_name ?? packName;
  return typeof pick === 'string' ? pick : null;
}

export async function readLockInput(p: SchemaPaths): Promise<CoreLockInput> {
  const expectedHashes: Record<string, string> = {};
  const sums = await Bun.file(join(p.packsDir, 'SHA256SUMS')).text();
  for (const line of sums.trim().split('\n')) {
    const [hash, file] = line.trim().split(/\s+/);
    if (hash && file) expectedHashes[file] = hash;
  }
  const installed: Record<string, PackFile | null> = {};
  const installedHashes: Record<string, string | null> = {};
  for (const [, name, shipped] of LAYERS) {
    const r = await readJson(join(p.gbrainHome, '.gbrain', 'schema-packs', name, 'pack.json'));
    installed[name] = (r?.json as PackFile) ?? null;
    if (shipped) installedHashes[shipped] = r ? sha(r.text) : null;
  }
  return {
    active: await activePackName(p.cli),
    core: installed['mobrain-core'] ?? null,
    personal: installed['mobrain-personal'] ?? null,
    brain: installed['mobrain-brain'] ?? null,
    installedHashes,
    expectedHashes,
  };
}

export type SchemaType = { name: string; primitive: string; prefixes: string[]; aliases: string[]; layer: 'core' | 'personal' | 'brain'; count: number | null };
export type SchemaView = {
  active: string | null;
  layers: { layer: string; name: string; version: string | null }[];
  types: SchemaType[];
  linkTypes: { name: string; layer: string }[];
  orphans: unknown[] | null;
  coreLock: CoreLockResult;
};

export async function buildSchemaView(p: SchemaPaths & { stats: Record<string, number> | null; orphans: unknown[] | null }): Promise<SchemaView> {
  const input = await readLockInput(p);
  const packs = { core: input.core, personal: input.personal, brain: input.brain };
  const types = new Map<string, SchemaType>();
  const links = new Map<string, { name: string; layer: string }>();
  for (const [layer] of LAYERS) {
    const pack = packs[layer];
    for (const t of pack?.page_types ?? []) {
      types.set(t.name, { name: t.name, primitive: t.primitive, prefixes: t.path_prefixes ?? [], aliases: t.aliases ?? [], layer, count: p.stats?.[t.name] ?? null });
    }
    for (const l of pack?.link_types ?? []) links.set(l.name, { name: l.name, layer });
  }
  return {
    active: input.active,
    layers: LAYERS.map(([layer, name]) => ({ layer, name, version: packs[layer]?.version ?? null })),
    types: [...types.values()],
    linkTypes: [...links.values()],
    orphans: p.orphans,
    coreLock: checkCoreLock(input),
  };
}
