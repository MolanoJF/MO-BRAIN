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
 * Capture the self-describing surfaces. Requires a running stack with an
 * initialized brain; the caller starts `gbrain serve` for the well-known probe.
 */
export async function captureCapability(opts: { serveBaseUrl?: string } = {}): Promise<CapabilitySnapshot> {
  const version = (await composeExec('gbrain-ops', ['gbrain', '--version'])).stdout.trim();
  const toolsRaw = await composeExec('gbrain-ops', ['gbrain', '--tools-json']);
  const packsRaw = await composeExec('gbrain-ops', ['gbrain', 'schema', 'list', '--json']);

  let wellKnown: CapabilitySnapshot['wellKnown'] = null;
  if (opts.serveBaseUrl) {
    const probe = await composeExec('gbrain-ops', [
      'sh', '-c', `curl -sf ${opts.serveBaseUrl}/.well-known/gbrain || true`,
    ]);
    if (probe.stdout.trim().startsWith('{')) {
      const body = JSON.parse(probe.stdout);
      wellKnown = { profiles: body.profiles ?? null, adapters: body.adapters ?? [] };
    }
  }

  const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

  return {
    gbrainVersion: version,
    capturedAt: new Date().toISOString(),
    tools: parse(toolsRaw.stdout),
    wellKnown,
    schemaPacks: parse(packsRaw.stdout),
  };
}
