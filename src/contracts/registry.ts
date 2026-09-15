import type { OperationSpec } from './types.ts';

/**
 * The allowlist. Slice 1's gbrain-ops RPC server exposes exactly these and
 * nothing else — there is no passthrough (G2, S2).
 *
 * Every entry is backed by a contract test asserting flag acceptance, --json
 * shape and exit codes at the pinned version (G4). Adding an entry without a
 * contract test is not allowed.
 */
export const OPERATIONS: Record<string, OperationSpec> = {
  // V3/V4. No --json: init reports through stdout prose and its exit code.
  init: {
    id: 'init',
    argv: ['init'],
    params: [
      { name: 'nonInteractive', flag: '--non-interactive', kind: 'flag' },
      { name: 'force', flag: '--force', kind: 'flag' },
      { name: 'url', flag: '--url', kind: 'value', secret: true },
      { name: 'embeddingModel', flag: '--embedding-model', kind: 'value' },
      { name: 'embeddingDimensions', flag: '--embedding-dimensions', kind: 'value' },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  // V4: the search-mode cost matrix is a post-init config set.
  // V11: upstream already routes vendor *_api_key writes away from the DB plane.
  'config.set': {
    id: 'config.set',
    argv: ['config', 'set'],
    params: [
      { name: 'key', flag: '', kind: 'value', required: true },
      { name: 'value', flag: '', kind: 'value', required: true },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  'config.get': {
    id: 'config.get',
    argv: ['config', 'get'],
    params: [{ name: 'key', flag: '', kind: 'value', required: true }],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  // Plan defect (Work Item C): the plan specified a `config list` subcommand
  // that does not exist upstream. gbrain's own usage line is
  // `gbrain config [show|get|set|unset] <key> [value]` (src/commands/config.ts,
  // runConfig dispatcher) — the read-all-config verb is `show`, not `list`.
  'config.show': {
    id: 'config.show',
    argv: ['config', 'show'],
    params: [],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  'auth.clients': {
    id: 'auth.clients',
    argv: ['auth', 'clients'],
    params: [],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  'auth.registerClient': {
    id: 'auth.registerClient',
    argv: ['auth', 'register-client'],
    params: [
      { name: 'name', flag: '', kind: 'value', required: true },
      { name: 'grantTypes', flag: '--grant-types', kind: 'value' },
      // Space-separated OAuth wire format; a comma list is rejected upstream.
      { name: 'scopes', flag: '--scopes', kind: 'value' },
      { name: 'source', flag: '--source', kind: 'value' },
      { name: 'federatedRead', flag: '--federated-read', kind: 'list' },
      { name: 'redirectUri', flag: '--redirect-uri', kind: 'value' },
      { name: 'tokenEndpointAuthMethod', flag: '--token-endpoint-auth-method', kind: 'value' },
      { name: 'boundTools', flag: '--bound-tools', kind: 'list' },
      { name: 'boundSource', flag: '--bound-source', kind: 'value' },
      { name: 'boundBrain', flag: '--bound-brain', kind: 'value' },
      { name: 'boundSlugPrefixes', flag: '--bound-slug-prefixes', kind: 'value' },
      { name: 'boundMaxConcurrent', flag: '--bound-max-concurrent', kind: 'value' },
      { name: 'budgetUsdPerDay', flag: '--budget-usd-per-day', kind: 'value' },
      // V7: 60s .. 90d. Server default for CLI-minted access tokens is 3600s.
      { name: 'tokenTtl', flag: '--token-ttl', kind: 'value' },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  'auth.rescopeClient': {
    id: 'auth.rescopeClient',
    argv: ['auth', 'rescope-client'],
    params: [
      { name: 'id', flag: '', kind: 'value', required: true },
      { name: 'source', flag: '--source', kind: 'value' },
      { name: 'federatedRead', flag: '--federated-read', kind: 'list' },
      { name: 'boundTools', flag: '--bound-tools', kind: 'list' },
      { name: 'boundSource', flag: '--bound-source', kind: 'value' },
      { name: 'boundBrain', flag: '--bound-brain', kind: 'value' },
      // 'none' clears the binding. Narrowing also disables extract_entities,
      // extract_facts, forget_fact, ontology_propose, sources_add/remove and
      // POST /ingest, and skips put_page's automatic fact extraction.
      { name: 'boundSlugPrefixes', flag: '--bound-slug-prefixes', kind: 'value' },
      { name: 'boundMaxConcurrent', flag: '--bound-max-concurrent', kind: 'value' },
      { name: 'budgetUsdPerDay', flag: '--budget-usd-per-day', kind: 'value' },
      { name: 'surface', flag: '--surface', kind: 'value' },
      { name: 'profile', flag: '--profile', kind: 'value' },
      { name: 'yes', flag: '--yes', kind: 'flag' },
    ],
    supportsJson: true,
    // Work Item E: the plan expected --dry-run here (rescopeClient's own
    // handler supports it, cli.ts:833/848), but gbrain 0.50.0.0's pre-dispatch
    // flag validator allowlists flags per top-level COMMAND, not subcommand,
    // and the 'auth' entry in cli-flag-registry.generated.ts omits
    // '--dry-run' — every `gbrain auth * --dry-run` is rejected before the
    // handler runs. Confirmed upstream bug; false here matches reality.
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  // V12: `gbrain sources add <id> --path <path>` — rejected over MCP by design.
  'sources.add': {
    id: 'sources.add',
    argv: ['sources', 'add'],
    params: [
      { name: 'id', flag: '', kind: 'value', required: true },
      { name: 'path', flag: '--path', kind: 'value' },
      { name: 'url', flag: '--url', kind: 'value' },
      { name: 'kind', flag: '--kind', kind: 'value' },
      { name: 'name', flag: '--name', kind: 'value' },
      { name: 'federated', flag: '--federated', kind: 'flag' },
      { name: 'noFederated', flag: '--no-federated', kind: 'flag' },
      { name: 'cloneDir', flag: '--clone-dir', kind: 'value' },
      { name: 'tokenEnv', flag: '--token-env', kind: 'value' },
      { name: 'force', flag: '--force', kind: 'flag' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },
};
