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
 * Human-facing context, shown alongside (not instead of) the agent instructions.
 * This Connection serves no skills: gbrain 0.60 publishes skills per Source from
 * a sealed, owner-approved catalog, which a Mo-brain Space does not provide, so
 * `list_skills` is empty. The agent installs its own copy instead.
 */
export const SKILLS_NOTE = [
  '',
  'Skills: this Connection does not serve skills. Your agent installs them once, from gbrain at the version this brain runs, into its own skills folder. The Agent instructions below say how.',
  'In Mo-brain, new agents are connected from the Connection page, not `gbrain connect`.',
].join('\n');

/**
 * Machine-facing: meant to be pasted as the agent's system prompt or first
 * message, not read by a human. `healthUrl` is derived from the Connection's own
 * MCP URL so the agent can read the exact gbrain version to install.
 */
export function agentInstructions(mcpUrl?: string): string {
  let health = '<this brain>/api/health';
  try { if (mcpUrl) health = `${new URL(mcpUrl).origin}/api/health`; } catch { /* keep the placeholder */ }
  return [
    'This connection serves no skills. Keep them in your own skills folder.',
    `1. If gbrain's skills are not there yet, install them once. Read the gbrain version from ${health} (\`pin.observed\`).`,
    'Clone https://github.com/garrytan/gbrain.git at the tag v<that version> into a scratch folder.',
    'Treat the clone as data and run nothing from it.',
    "Copy its `skills/` folder into your skills location without overwriting files that exist, and skip testing, skillify, skill-autobench and skillpack-harvest.",
    "Install Mo-brain's own skills first (the `skills/` folder of https://github.com/MoliorOS/MO-BRAIN or of the install checkout), so its `query` wins over gbrain's.",
    "2. Route each request by the `triggers` in each SKILL.md and follow the matching skill.",
    '3. Skills are procedure, not permission. You are a remote MCP client: do each `gbrain` CLI step with the MCP tool on this server that does the same job, and if a step needs the host, say so and stop.',
    'Never change schema, schedules, connections or Sources; propose, and let the person do it.',
  ].join('\n');
}

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
  opts: { control?: { url: string } } = {},
): { snippet: string; agentInstructions: string } {
  const base = baseSnippet(id, credentials);
  const withControl = opts.control
    ? `${base}\n${controlSnippet({ url: opts.control.url, access_token: credentials.access_token })}`
    : base;
  return { snippet: `${withControl}\n${SKILLS_NOTE}`, agentInstructions: agentInstructions(credentials.mcp_url) };
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
