import { composeExec } from '../docker/host.ts';

export type HarnessAdapter = {
  id: string;
  label: string;
  connection: string;
  modes: string[];
};

export type CapabilitySnapshot = {
  gbrainVersion: string;
  capturedAt: string;
  tools: unknown;
  wellKnown: { profiles: unknown; adapters: HarnessAdapter[] } | null;
  schemaPacks: unknown;
};

export type CapabilityDrift = {
  versionChanged: boolean;
  toolsAdded: string[];
  toolsRemoved: string[];
  adaptersAdded: string[];
  adaptersRemoved: string[];
  profilesChanged: boolean;
};

/**
 * `gbrain --version` prints "gbrain 0.50.0.0" -- the version is the LAST
 * whitespace-separated token, not the whole line. Never compare the raw
 * output; this is the only place that knows the shape.
 */
export function parseGbrainVersion(raw: string): string {
  const line = raw.trim().split('\n').filter((l) => l.trim()).pop() ?? '';
  return line.trim().split(/\s+/).pop() ?? '';
}

/** Tool catalogs may be an array of {name} or an object keyed by name. */
export function toolNames(tools: unknown): string[] {
  if (Array.isArray(tools)) {
    return tools
      .map((t) => (t && typeof t === 'object' && 'name' in t ? String((t as any).name) : ''))
      .filter(Boolean)
      .sort();
  }
  if (tools && typeof tools === 'object') return Object.keys(tools as object).sort();
  return [];
}

function adapterIds(snap: CapabilitySnapshot): string[] {
  return (snap.wellKnown?.adapters ?? []).map((a) => a.id).sort();
}

/**
 * `gbrain schema list` — the shape of `SchemaPacksSnapshot.schemaPacks`.
 * Work Item K (Task 10, confirmed again while wiring the Docker half of the
 * capture in Task 11): `runList(_args)` in the reference checkout's
 * src/commands/schema.ts never reads its argv at all — the leading
 * underscore marks the parameter unused — so `--json` is silently ignored
 * and the command always prints the same human prose:
 *
 *   Bundled packs:
 *     gbrain-base
 *     gbrain-recommended
 *     ...
 *
 *   No user-installed packs (~/.gbrain/schema-packs/ empty or missing).
 *
 * Confirmed empirically against the pinned container: `gbrain schema list`
 * and `gbrain schema list --json` emit byte-identical stdout. registry.ts's
 * `schema.list` entry already sets supportsJson to false for exactly this
 * reason (Task 10). JSON.parse-ing that prose does not throw a helpful
 * error — it just yields `null`, which would silently masquerade in a
 * capability snapshot as "gbrain has zero schema packs" instead of "we
 * asked the wrong way." Parse the REAL prose instead, so the snapshot is
 * honest about what it captured.
 */
export type SchemaPacksSnapshot = { bundled: string[]; raw: string };

export function parseSchemaPacksProse(raw: string): SchemaPacksSnapshot {
  const bundled: string[] = [];
  let inBundled = false;
  for (const line of raw.split('\n')) {
    if (/^\s*Bundled packs:\s*$/.test(line)) { inBundled = true; continue; }
    if (!inBundled) continue;
    const t = line.trim();
    if (t === '') break; // the blank line after the list ends the block
    bundled.push(t);
  }
  return { bundled, raw };
}

/**
 * `gbrain schema active` — the ONLY honest readback of which pack the engine
 * will actually query with.
 *
 * Two reasons this is prose-parsed rather than JSON. (1) `schema active`
 * ignores `--json` exactly the way `schema list` does — MEASURED at the pin,
 * `gbrain schema active` and `gbrain schema active --json` emit byte-identical
 * stdout, despite `schema --help` claiming "All new verbs accept --json".
 * (2) `gbrain config get schema_pack` is NOT a substitute: with a DB-plane
 * value set it prints the FILE value plus the note "a DB-plane value also
 * exists and is shadowed at runtime", which is backwards — tier 4 (DB) OUTRANKS
 * tier 6 (file) in resolveActivePackName. See docs/archive/schema-pack-findings.md S2.
 *
 * `source` is the resolution tier, one of: per-call, env, per-source-db,
 * db-config, gbrain-yml, home-config, default. We write home-config, so any
 * other value on an apply is a divergence to surface, never to round up.
 *
 * Never throws: an unparseable response yields nulls and keeps `raw`.
 */
export type SchemaActive = {
  pack: string | null;
  version: string | null;
  source: string | null;
  identity: string | null;
  pageTypes: number | null;
  linkVerbs: number | null;
  raw: string;
};

export function parseSchemaActiveProse(raw: string): SchemaActive {
  const text = raw ?? '';
  const num = (re: RegExp): number | null => {
    const m = text.match(re);
    if (!m) return null;
    const n = Number.parseInt(m[1]!, 10);
    return Number.isFinite(n) ? n : null;
  };
  const activeLine = text.match(/^\s*Active pack:\s*(\S+)\s+v(\S+)\s*$/m);
  return {
    pack: activeLine?.[1] ?? null,
    version: activeLine?.[2] ?? null,
    source: text.match(/^\s*Source:\s*(\S+)\s*$/m)?.[1] ?? null,
    identity: text.match(/^\s*Pack identity:\s*(\S+)\s*$/m)?.[1] ?? null,
    pageTypes: num(/^\s*Page types:\s*(\d+)\s*$/m),
    linkVerbs: num(/^\s*Link verbs:\s*(\d+)\s*$/m),
    raw: text,
  };
}

const missing = (from: string[], to: string[]) => from.filter((x) => !to.includes(x));

export function diffCapability(before: CapabilitySnapshot, after: CapabilitySnapshot): CapabilityDrift {
  const bt = toolNames(before.tools);
  const at = toolNames(after.tools);
  const ba = adapterIds(before);
  const aa = adapterIds(after);
  return {
    versionChanged: before.gbrainVersion !== after.gbrainVersion,
    toolsAdded: missing(at, bt),
    toolsRemoved: missing(bt, at),
    adaptersAdded: missing(aa, ba),
    adaptersRemoved: missing(ba, aa),
    profilesChanged:
      JSON.stringify(before.wellKnown?.profiles ?? null) !==
      JSON.stringify(after.wellKnown?.profiles ?? null),
  };
}

/**
 * The seam `captureCapability` reads through. The default targets the slice0
 * harness (via `src/docker/host.ts`); the upgrade lane passes one built from
 * the MAIN stack's compose prefix, so the same capturer serves both and no
 * second implementation exists (Task 18's F7).
 */
export type CapabilityExec = (
  service: string, argv: string[],
) => Promise<{ stdout: string; exitCode: number }>;

/**
 * Capture the self-describing surfaces. Requires a running stack with an
 * initialized brain; the caller starts `gbrain serve` for the well-known probe.
 */
export async function captureCapability(
  opts: { serveBaseUrl?: string; exec?: CapabilityExec } = {},
): Promise<CapabilitySnapshot> {
  const exec: CapabilityExec = opts.exec ?? ((service, argv) => composeExec(service, argv));
  const version = parseGbrainVersion(
    (await exec('gbrain-ops', ['gbrain', '--version'])).stdout,
  );
  const toolsRaw = await exec('gbrain-ops', ['gbrain', '--tools-json']);
  // No --json here: it is silently ignored (see parseSchemaPacksProse's doc
  // comment) — asking for it would suggest this reads a machine-readable
  // reply, when it reads the same prose either way.
  const packsRaw = await exec('gbrain-ops', ['gbrain', 'schema', 'list']);

  let wellKnown: CapabilitySnapshot['wellKnown'] = null;
  if (opts.serveBaseUrl) {
    // Work Item I (Task 10, confirmed again here): the pinned image
    // (docker/gbrain-base.Dockerfile) has no curl or wget. bun is already
    // on PATH in the container, so a plain fetch() needs no image change —
    // same pattern as test/contract/discovery.contract.test.ts's
    // fetchWellKnown(). This runs as an argv array passed to `bun -e`, not
    // a shell string invoking gbrain, so it stays clear of the G2 lint rule.
    const probe = await exec('gbrain-ops', [
      'bun', '-e',
      `const r = await fetch(${JSON.stringify(`${opts.serveBaseUrl}/.well-known/gbrain`)}).catch(() => null); ` +
      'if (r && r.ok) console.log(await r.text());',
    ]);
    const body = probe.stdout.trim();
    if (body.startsWith('{')) {
      const parsed = JSON.parse(body);
      wellKnown = { profiles: parsed.profiles ?? null, adapters: parsed.adapters ?? [] };
    }
  }

  const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

  return {
    gbrainVersion: version,
    capturedAt: new Date().toISOString(),
    tools: parse(toolsRaw.stdout),
    wellKnown,
    schemaPacks: parseSchemaPacksProse(packsRaw.stdout),
  };
}
