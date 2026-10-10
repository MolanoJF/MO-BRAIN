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
  access_token?: string;
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

function baseSnippet(id: string, credentials: WiringCredentials): string {
  const klass = connectionClass(id);
  if (klass === 'manual') {
    const mcpUrl = credentials.mcp_url ?? '<mcp_url>';
    const accessToken = credentials.access_token ?? '<access_token>';
    const fragment = JSON.stringify(
      {
        mcpServers: {
          gbrain: {
            type: 'http',
            url: mcpUrl,
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        },
      },
      null,
      2,
    );
    return [
      'Copy/paste this MCP config fragment into the harness:',
      fragment,
      '',
    ].join('\n');
  }
  return `gbrain mcp grant already wrote this adapter's config (${klass}).`;
}

/**
 * Human-facing context, shown alongside (not instead of) AGENT_INSTRUCTIONS.
 * Appended only when the claim read `mcp.publish_skills` back as true.
 */
export const SKILLS_NOTE = [
  '',
  'Skills: this Connection serves gbrain skills over MCP, so there is nothing to install.',
  'Ask your agent to call `list_skills`, then `get_skill` with a skill name, and follow what it returns.',
  "A skill whose tools show up under `unavailable_tools` is outside your role. Skip it.",
  'In Mo-brain, new agents are connected from the Connection page, not `gbrain connect`.',
].join('\n');

/**
 * Machine-facing: meant to be pasted as the agent's system prompt or first
 * message, not read by a human. MCP-native — the agent pulls skills over its
 * own Connection, so nothing is installed and nothing can go stale.
 */
export const AGENT_INSTRUCTIONS = [
  'Before responding to any request on this connection, call `list_skills`.',
  "If a returned skill's triggers match the user's request, call `get_skill`",
  'with its name and follow the returned instructions. Only call tools listed',
  "in that skill's `usable_tools` — tools under `unavailable_tools` are not",
  'callable by you on this server.',
].join(' ');

/**
 * Spec agent-control-mcp §6 / review R9: the control server, declared beside
 * the data server with the SAME bearer. Appended for every class: the grant
 * only ever wrote the data server's config.
 */
export function controlSnippet(control: { url: string; access_token?: string }): string {
  const fragment = JSON.stringify({
    mcpServers: {
      'mobrain-control': {
        type: 'http',
        url: control.url,
        headers: { Authorization: `Bearer ${control.access_token ?? '<access_token>'}` },
      },
    },
  }, null, 2);
  return [
    'Mo-brain control server (operate schemas, sources, members and schedules within your role).',
    'Add it beside the data server, with the same token:',
    fragment,
    '',
  ].join('\n');
}

export function wiringSnippet(
  id: string,
  credentials: WiringCredentials,
  opts: { skills?: boolean; control?: { url: string } } = {},
): { snippet: string; agentInstructions: string | null } {
  const base = baseSnippet(id, credentials);
  const withControl = opts.control
    ? `${base}\n${controlSnippet({ url: opts.control.url, access_token: credentials.access_token })}`
    : base;
  const snippet = opts.skills ? `${withControl}\n${SKILLS_NOTE}` : withControl;
  return { snippet, agentInstructions: opts.skills ? AGENT_INSTRUCTIONS : null };
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
