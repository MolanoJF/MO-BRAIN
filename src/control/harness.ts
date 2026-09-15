/**
 * Hardcoded harness id → connection-class map.
 *
 * Upstream follow-up: `publicHarnessMetadata()` strips `.connection`, so the
 * live `/.well-known/gbrain` payload cannot drive picker grouping — restore
 * that field and delete this map.
 */

export type ConnectionClass =
  | 'claude-json'
  | 'codex-toml'
  | 'opencode-json'
  | 'thin-cli'
  | 'manual';

/** Credential fields safe to embed in a copy/paste wiring snippet. */
export type WiringCredentials = {
  client_id?: string;
  mcp_url?: string;
};

/**
 * C3/V10: id → connection class. Drift-tested against capability.json
 * wellKnown.adapters (both directions).
 */
export const HARVEST_MAP: Readonly<Record<string, ConnectionClass>> = {
  'claude-code': 'claude-json',
  codex: 'codex-toml',
  opencode: 'opencode-json',
  openclaw: 'thin-cli',
  'grok-bot': 'thin-cli',
  muse: 'thin-cli',
  'claude-desktop': 'manual',
  'grok-build': 'manual',
  'muse-code': 'manual',
  cursor: 'manual',
  perplexity: 'manual',
  chatgpt: 'manual',
  generic: 'manual',
};

export function connectionClass(id: string): ConnectionClass {
  const klass = HARVEST_MAP[id];
  if (!klass) throw new Error(`unknown harness adapter: ${id}`);
  return klass;
}

/** Auto-install is never promised for the `manual` class. */
export function autoInstall(id: string): boolean {
  return connectionClass(id) !== 'manual';
}

export function wiringSnippet(id: string, credentials: WiringCredentials): string {
  const klass = connectionClass(id);
  if (klass === 'manual') {
    const clientId = credentials.client_id ?? '<client_id>';
    const mcpUrl = credentials.mcp_url ?? '<mcp_url>';
    const fragment = JSON.stringify(
      {
        mcpServers: {
          gbrain: {
            url: mcpUrl,
            client_id: clientId,
          },
        },
      },
      null,
      2,
    );
    return [
      'Copy/paste this MCP config fragment into the harness:',
      fragment,
      'We have not runtime-tested this adapter.',
    ].join('\n');
  }
  return `gbrain mcp grant already wrote this adapter's config (${klass}).`;
}

/** Attach connectionClass + autoInstall for GET /api/harnesses. */
export function annotateAdapters<T extends { id: string }>(
  adapters: T[],
): Array<T & { connectionClass: ConnectionClass; autoInstall: boolean }> {
  return adapters.map((a) => ({
    ...a,
    connectionClass: connectionClass(a.id),
    autoInstall: autoInstall(a.id),
  }));
}
