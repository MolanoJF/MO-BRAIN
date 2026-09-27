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
      /**
       * UNDOCUMENTED but allowlisted and honored. `gbrain init --help` does
       * not list it, but it is in the per-command flag allowlist — MEASURED at
       * 0.50.5.0: `gbrain init --schema-pack` (no value) answers
       * `--schema-pack requires a value`, whereas `gbrain init --bogus-flag`
       * answers `unknown flag --bogus-flag for 'gbrain init'`. Run with a value
       * it prints `[init] Using schema pack: <name>` and the choice takes
       * effect (src/commands/init.ts:53-56, 1346, 1687).
       *
       * This is where the wizard's pack choice has to land, not a post-init
       * `config set`: init WRITES config.json's schema_pack itself, defaulting
       * new brains to `gbrain-base-v2`, so anything written beforehand is
       * stamped over — and the pack must already be active when `sync` runs
       * for imported pages to be typed by it.
       */
      { name: 'schemaPack', flag: '--schema-pack', kind: 'value' },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * Task 12 — the honest half of the isolation check. `gbrain init
   * --mcp-only` writes a `remote_mcp` config field under whatever
   * GBRAIN_HOME the caller sets and runs three LIVE pre-flight smokes
   * (OAuth discovery, a client_credentials token round-trip, an MCP
   * `initialize`) against a reachable `gbrain serve` — it never opens a
   * local engine and never touches GBRAIN_DATABASE_URL. That is exactly
   * what makes it the mechanism a Slice 1 control-plane container (which
   * never holds brain-db credentials, S2) can run on behalf of a scoped
   * end user: give each simulated teammate their own GBRAIN_HOME and this
   * operation, plus the `mcp.grant` credentials it consumes, and `search`/
   * `whoami` afterward are transparently routed over MCP as that OAuth
   * client — never as gbrain-ops's own local admin identity. Confirmed
   * empirically against the pinned container (no --dry-run support exists
   * in the reference checkout's cli-flag-registry 'init' entry).
   */
  'init.mcpOnly': {
    id: 'init.mcpOnly',
    argv: ['init', '--mcp-only'],
    params: [
      { name: 'issuerUrl', flag: '--issuer-url', kind: 'value', required: true },
      { name: 'mcpUrl', flag: '--mcp-url', kind: 'value', required: true },
      { name: 'oauthClientId', flag: '--oauth-client-id', kind: 'value', required: true },
      { name: 'oauthClientSecret', flag: '--oauth-client-secret', kind: 'value', required: true, secret: true },
      { name: 'force', flag: '--force', kind: 'flag' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'read-only',
    okExitCodes: [0],
  },

  // V4: the search-mode cost matrix is a post-init config set.
  // V11: upstream already routes vendor *_api_key writes away from the DB plane.
  // Also the tier-3 write path (`schema_pack.source.<id>`, S1): the key is not
  // in gbrain's KNOWN_CONFIG_KEY_PREFIXES, so `config set` exits 1 without the
  // `force` param below (S6 probe 1).
  'config.set': {
    id: 'config.set',
    argv: ['config', 'set'],
    params: [
      { name: 'key', flag: '', kind: 'value', required: true },
      { name: 'value', flag: '', kind: 'value', required: true },
      /**
       * REQUIRED for the tier-3 key `schema_pack.source.<id>`: it is NOT in
       * gbrain's `KNOWN_CONFIG_KEY_PREFIXES`, so `config set` exits 1 with
       * `Unknown config key` unless `--force` is passed (MEASURED at 0.50.5.0;
       * docs/schema-pack-findings.md S1 and S6 probe 1). With `--force` it
       * lands in the brain DB `config` table, not the file plane — which is
       * exactly the tier-3 plane the resolver reads.
       */
      { name: 'force', flag: '--force', kind: 'flag' },
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

  /**
   * Clears one key. This is how a per-source pack override is reset: it
   * removes the tier-3 key `schema_pack.source.<id>` from the brain DB
   * `config` table (S1), so the source falls back to the brain-wide pack.
   * MEASURED grammar (docs/schema-pack-findings.md S6 probe 5):
   *   `gbrain config unset <key> | --pattern <prefix>`
   * a no-arg call exits 1 with that usage line, and a missing key exits 1
   * with `Config key not found`. `--pattern <prefix>` exists but is not
   * exposed: the per-source reset names one key, never a prefix.
   */
  'config.unset': {
    id: 'config.unset',
    argv: ['config', 'unset'],
    params: [{ name: 'key', flag: '', kind: 'value', required: true }],
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

  /**
   * V15: `gbrain auth revoke-client <client_id>` is a bare positional with
   * no flags and no `--json`. Exit 1 on missing-arg and not-found. Prose
   * output only. V16: CLI revoke is unconditional DELETE (cascades tokens
   * and codes). Rotation is not revocation (honesty rule 4).
   */
  'auth.revokeClient': {
    id: 'auth.revokeClient',
    argv: ['auth', 'revoke-client'],
    params: [{ name: 'clientId', flag: '', kind: 'value', required: true }], // positional
    supportsJson: false,   // V15 — requesting --json throws in buildArgv
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  // V12: `gbrain sources add <id> --path <path>` — rejected over MCP by design.
  //
  // Plan defect (Work Item N, found building Task 12): `sources add` does
  // NOT support --json, unlike its siblings `list`/`status`/`archived`.
  // Confirmed two ways against the running pinned container: (1) `gbrain
  // sources add <id> --path <p> --json` exits 2 with "Unknown flag: --json"
  // — the per-command flag allowlist in cli-flag-registry.generated.ts's
  // 'sources' entry does carry '--json', but sources.ts's own `printHelp()`
  // usage line only lists --json for `list`/`status`/`archived`, and (2)
  // that usage line's shape for `add` is exactly `add <id> --path <p>
  // [--name <n>] [--federated|--no-federated] [--force]` — no --json.
  // Neither existing contract test (auth, mcp-grant) ever passed
  // `json: true` to this operation, so the wrong `true` here went
  // undetected until the tutorial script needed a real receipt to read
  // `source_id` off of. Fixed to false; the tutorial reads sources.add's
  // plain-text confirmation instead of parsing JSON from it.
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
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * V8: needs a local engine or --admin-token-file. Whatever runs this holds
   * DATABASE_URL, which is why it lives in gbrain-ops and never in the
   * control plane (S2).
   */
  'mcp.grant': {
    id: 'mcp.grant',
    argv: ['mcp', 'grant'],
    params: [
      // Plan defect (Work Item F): the plan's params list omitted the
      // positional NAME gbrain requires ("Usage: gbrain mcp grant NAME
      // [options]", src/commands/mcp.ts parseMcpGrant) — every grant call
      // failed at arg-parsing before this was added.
      { name: 'name', flag: '', kind: 'value', required: true },
      { name: 'harness', flag: '--harness', kind: 'value' },
      { name: 'profile', flag: '--profile', kind: 'value' },
      { name: 'client', flag: '--client', kind: 'value' },
      { name: 'source', flag: '--source', kind: 'value' },
      { name: 'federatedRead', flag: '--federated-read', kind: 'list' },
      { name: 'boundTools', flag: '--bound-tools', kind: 'list' },
      { name: 'boundSource', flag: '--bound-source', kind: 'value' },
      { name: 'boundBrain', flag: '--bound-brain', kind: 'value' },
      { name: 'boundSlugPrefixes', flag: '--bound-slug-prefixes', kind: 'value' },
      { name: 'boundMaxConcurrent', flag: '--bound-max-concurrent', kind: 'value' },
      { name: 'budgetUsdPerDay', flag: '--budget-usd-per-day', kind: 'value' },
      { name: 'delegatedSlugPrefixes', flag: '--delegated-slug-prefixes', kind: 'value' },
      { name: 'delegatedNamespace', flag: '--delegated-namespace', kind: 'value' },
      { name: 'tokenTtl', flag: '--token-ttl', kind: 'value' },
      { name: 'credentialsOut', flag: '--credentials-out', kind: 'value' },
      { name: 'adminTokenFile', flag: '--admin-token-file', kind: 'value', secret: true },
      { name: 'ifVersion', flag: '--if-version', kind: 'value' },
      { name: 'resume', flag: '--resume', kind: 'flag' },
      // Plan defect (Work Item G): required, not optional. `parseMcpGrant`
      // defaults absent --url to '', and `provisionHarnessGrant` validates it
      // with normalizeMcpUrl/assertSecureEndpoint unconditionally — including
      // on --dry-run — before any dry-run branch runs (mcp-provision.ts:22-24
      // in the read-only reference checkout). An empty url always fails with
      // reason "mcp_setup_failed": "Pass a valid MCP endpoint URL".
      { name: 'url', flag: '--url', kind: 'value', required: true, secret: true },
    ],
    supportsJson: true,
    supportsDryRun: true,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * Exit 2 = 'partial': server stages passed but harness evidence is missing.
   * NEVER render that green (honesty rule 5). Note every adapter carries
   * evidence.runtimeTestedAt: null (V10).
   */
  'mcp.verify': {
    id: 'mcp.verify',
    argv: ['mcp', 'verify'],
    params: [
      { name: 'client', flag: '--client', kind: 'value' },
      { name: 'harness', flag: '--harness', kind: 'value' },
      { name: 'url', flag: '--url', kind: 'value', required: true, secret: true },
      { name: 'credentialsFile', flag: '--credentials-file', kind: 'value', secret: true },
      { name: 'timeoutMs', flag: '--timeout-ms', kind: 'value' },
      { name: 'delegate', flag: '--delegate', kind: 'flag' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * V17: `gbrain mcp profiles` exists and returns JSON on stdout
   * (`{profiles, default:'memory-writer', ...}`). supportsJson is false
   * because the command IS json — there is no `--json` flag we pass.
   * The connection builder needs the authoritative profile list and its
   * `default`.
   */
  'mcp.profiles': {
    id: 'mcp.profiles',
    argv: ['mcp', 'profiles'],
    params: [],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * V6: exits non-zero on blockers (1, and 2 on the unreachable-target path).
   * okExitCodes is [0] deliberately — a blocker IS a failure for our gate.
   */
  doctor: {
    id: 'doctor',
    argv: ['doctor'],
    params: [
      { name: 'remediate', flag: '--remediate', kind: 'flag' },
      { name: 'yes', flag: '--yes', kind: 'flag' },
      { name: 'targetScore', flag: '--target-score', kind: 'value' },
      { name: 'maxUsd', flag: '--max-usd', kind: 'value' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * V5 exit codes (start): 0 clean shutdown (SIGTERM/SIGINT, worker drained),
   * 1 max crashes exceeded, 2 another supervisor holds the PID lock,
   * 3 PID file unwritable. `stop` waits up to 40s for graceful drain.
   *
   * Confirmed against the reference checkout (src/commands/jobs.ts, the
   * 'supervisor' case): with --detach, the PARENT forks a fully detached,
   * unref'd child (spawnDetachedSupervisor) and exits 0 immediately, BEFORE
   * a MinionSupervisor is constructed — so exit 2 (LOCK_HELD) is never
   * observable from a --detach invocation's own exit code, only from a
   * FOREGROUND second start. See Work Item H in the test file.
   */
  'jobs.supervisor': {
    id: 'jobs.supervisor',
    argv: ['jobs', 'supervisor', 'start'],
    params: [
      { name: 'concurrency', flag: '--concurrency', kind: 'value' },
      { name: 'detach', flag: '--detach', kind: 'flag' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  'jobs.supervisorStatus': {
    id: 'jobs.supervisorStatus',
    argv: ['jobs', 'supervisor', 'status'],
    params: [],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    // 0 = running, 1 = not running. Both are valid answers, not failures.
    okExitCodes: [0, 1],
  },

  'jobs.supervisorStop': {
    id: 'jobs.supervisorStop',
    argv: ['jobs', 'supervisor', 'stop'],
    params: [],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * The tripwire probe (docs/autopilot-status-findings.md). OBSERVED at
   * 0.50.5.0: `--status --json` prints one AutopilotStatusReport,
   * { installed, install_target, state, disabled_reason, paused_reason,
   *   heartbeat_age_seconds, stale_after_seconds, last_log },
   * and never opens the engine: it reads only the filesystem, so it answers
   * during a DB outage. `--source` is silently ignored — no source scope.
   *
   * okExitCodes [0, 1, 2]: upstream's autopilotStatusExitCode maps
   * disabled→2, stale/never_run/paused→1, else 0. Each is a verdict, not a
   * crash. But 1 and 2 are ALSO usage-error exits that print no JSON, so the
   * scheduler never classifies on the exit code alone (classifyExit).
   *
   * Only the status verb is allowlisted. The install verb is lint-forbidden
   * and deliberately absent: the scheduler service replaces it.
   */
  'autopilot.status': {
    id: 'autopilot.status',
    argv: ['autopilot', '--status'],
    params: [],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0, 1, 2],
  },

  applyMigrations: {
    id: 'applyMigrations',
    argv: ['apply-migrations'],
    params: [
      { name: 'yes', flag: '--yes', kind: 'flag' },
      { name: 'nonInteractive', flag: '--non-interactive', kind: 'flag' },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  // V14: the public CLI tool-catalog contract. Data-plane half of the snapshot.
  toolsJson: {
    id: 'toolsJson',
    argv: ['--tools-json'],
    params: [],
    supportsJson: false, // the command IS the json
    supportsDryRun: false,
    privilege: 'read-only',
    okExitCodes: [0],
  },

  // Plan defect (Work Item K): `schema list`'s handler ignores --json
  // entirely (runList(_args) in src/commands/schema.ts never reads its
  // argument) and always prints human prose. Confirmed empirically.
  // supportsJson is false, not true, so a caller can't silently ask for a
  // structured response this command will never give it.
  'schema.list': {
    id: 'schema.list',
    argv: ['schema', 'list'],
    params: [],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * The honest readback for which pack the engine actually resolves. Prose
   * only: MEASURED at 0.50.5.0, `gbrain schema active` and
   * `gbrain schema active --json` emit byte-identical stdout — `runActive`
   * takes `_args` and never reads it, the same defect shape as `schema list`
   * (Work Item K). `schema --help`'s blanket "All new verbs accept --json" is
   * wrong. supportsJson is false so a caller cannot ask for a structured reply
   * this command will never give; parse it with `parseSchemaActiveProse`.
   *
   * This is the ONLY command that reports the resolution TIER, which is what
   * makes it load-bearing: a brain-DB-plane `schema_pack` (tier 4) silently
   * outranks the ~/.gbrain/config.json value we write (tier 6), and
   * `gbrain schema use` will report success while changing nothing in that
   * state (MEASURED). `gbrain config get schema_pack` cannot be used instead —
   * its shadowing note is inverted. See docs/schema-pack-findings.md S2.
   *
   * Reads DB config for tier 4, so: brain-db.
   */
  'schema.active': {
    id: 'schema.active',
    argv: ['schema', 'active'],
    params: [],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * A pack's resolved manifest, without activating it. `params: []` is
   * DELIBERATE: a positional pack name returns the *unresolved* manifest —
   * MEASURED at 0.50.5.0, `gbrain schema show <pack> --json` runs
   * `loadPackFromFile(path)` and never walks `extends`/`borrow_from`. Raw vs
   * effective (docs/schema-pack-findings.md S4):
   *
   *   pack               | raw page types | effective
   *   gbrain-base        | 27             | 27
   *   gbrain-base-v2     | 19             | 19
   *   gbrain-recommended | 12             | 32
   *   gbrain-creator     |  1             | 27
   *   gbrain-investor    |  2             | 29
   *   gbrain-engineer    |  1             | 28
   *   gbrain-everything  |  0             | 30
   *
   * Resolution must be done by gbrain's own resolver, via the env tier with
   * NO positional (tier 2 of the chain, S1): `GBRAIN_SCHEMA_PACK=<pack>
   * gbrain schema show --json` routes through `resolvePack` /
   * `mergeInheritedManifest`. That env var is injected for one spawn by Task
   * 1's `packOverride` seam in src/ops/server.ts. Reimplementing the merge in
   * TypeScript would be a false claim — it is child-wins de-duplication, not a
   * union (`gbrain-creator` is 27 effective from 27 base + 1 own, S4).
   *
   * supportsJson: true — unlike `active`/`list`, `runShow` DOES skip flags
   * when finding the positional (`args.find(a => !a.startsWith('--'))`), so
   * `--json` works in either position (S5).
   */
  'schema.show': {
    id: 'schema.show',
    argv: ['schema', 'show'],
    params: [],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * Manifest-shape validation for one pack. The companion to `schema.lint`,
   * and NOT redundant with it: MEASURED at the pin, `schema lint <name>` on a
   * pack that exists but fails to parse answers the misleading
   * `Pack not found: <name>` — `runLintCmd` swallows the loader exception
   * (`catch { raw = null; }`) — while `schema validate <name>` gives the real
   * diagnosis, e.g. `manifest validation failed: page_types.0.primitive:
   * Invalid option: expected one of "entity"|"media"|...`. An admin needs the
   * second message, so the console runs both.
   *
   * Grammar: the pack name is a POSITIONAL and optional (absent falls back to
   * gbrain-base, NOT to the active pack — `runValidate` hardcodes
   * `packPathByName('gbrain-base')`, schema.ts:329). supportsJson is false for
   * two compounding reasons: `runValidate` reads `args[0]` raw and never calls
   * `parseFlags`, so a LEADING `--json` is misparsed as the pack name and exits
   * 1 (MEASURED: `schema validate --json dirpack` → exit 1), while a TRAILING
   * `--json` is silently ignored and prose is printed anyway (MEASURED:
   * `schema validate dirpack --json` → exit 0, prose). Exit 0 = valid,
   * 1 = unknown pack or invalid manifest; the caller reads stdout/stderr for
   * the reason.
   */
  'schema.validate': {
    id: 'schema.validate',
    argv: ['schema', 'validate'],
    params: [
      { name: 'packName', flag: '', kind: 'value' },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'read-only',
    okExitCodes: [0],
  },

  /**
   * Plan defect (Work Item S, Task 13): `--pack` is NOT how you name a pack
   * for `schema lint`. `runLintCmd`'s own `parseFlags()` (src/commands/
   * schema.ts) recognizes only `--json`/`--source`/`--source-id` — every
   * other token, `--with-db` and `--pack` included, falls through into its
   * `positional` array untouched, and `name = positional[0]`. Confirmed
   * empirically: `gbrain schema lint --with-db --json` exits 1 with `Pack
   * not found: --with-db`, because `--with-db` itself became `positional[0]`
   * — there is no `--pack` flag to catch a value first. The real grammar is
   * a POSITIONAL pack name, optional (falls back to the active pack):
   * `gbrain schema lint [PACK_NAME] [--with-db] [--json]`. Confirmed
   * working both ways: `gbrain schema lint --json` (active pack) and
   * `gbrain schema lint gbrain-base --with-db --json` (named pack — the
   * positional MUST come before --with-db, or the same misparse recurs).
   * `packName` is listed first in `params` for exactly that reason:
   * `buildArgv` emits params in array order.
   */
  'schema.lint': {
    id: 'schema.lint',
    argv: ['schema', 'lint'],
    params: [
      { name: 'packName', flag: '', kind: 'value' },
      { name: 'withDb', flag: '--with-db', kind: 'flag' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * Plan defect (Work Item S, Task 13): two bugs. (1) `--pack` here is
   * exactly as inert as it is for `schema.lint` above — `runSyncCmd` never
   * reads a pack selector at all (it always syncs against the engine's
   * currently active pack) — so the param did nothing and was dropped
   * rather than kept as dead API surface. (2) `supportsDryRun: true` is
   * wrong: `schema` is not in cli-flag-registry.generated.ts's per-command
   * allowlist for `--dry-run` at all. Confirmed empirically: `gbrain schema
   * sync --dry-run --json` is rejected before dispatch —
   * `{"status":"error","reason":"invalid_flag","message":"unknown flag
   * --dry-run for 'gbrain schema'"}`, exit 1. Preview IS the default mode
   * here — `apply: false` (the absence of `--apply`) already previews
   * without mutating, confirmed via `gbrain schema sync --json` returning a
   * `per_prefix`/`total_would_apply` report with `"apply": false` and zero
   * `applied` counts. `supportsDryRun` fixed to false; our generic
   * `{ dryRun: true }` mechanism assumes gbrain literally has a `--dry-run`
   * flag, which this command does not.
   *
   * `--source <id>` is real and PROVEN to fence (Task 0 gate 4, superseding
   * the plan's "unproven on the near-empty brain" note): with one untyped page
   * seeded in each of two sources, `schema sync --source customers --json`
   * reported `total_would_apply: 1` where the brain-wide run reported 2, and
   * `probePrefix`/`applyTypeAssignment` both append `AND source_id = $N` — the
   * fence covers the count, the sample AND the UPDATE (S6 probe 4, S3).
   * Sync is additive-only: it fills blank types (`(type IS NULL OR type = '')`)
   * and cannot reclassify, delete or unembed anything (S3). The UI copy must
   * say "fills blank types", never "reclassifies".
   */
  'schema.sync': {
    id: 'schema.sync',
    argv: ['schema', 'sync'],
    params: [
      { name: 'apply', flag: '--apply', kind: 'flag' },
      { name: 'source', flag: '--source', kind: 'value' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * Copies a pack's RAW manifest to `~/.gbrain/schema-packs/<to>/pack.json`
   * at version 0.0.1 (runForkCmd). The one way to make a bundled pack
   * editable: mutations refuse bundled packs with PACK_READONLY. MEASURED,
   * docs/schema-pack-findings.md S7.
   */
  'schema.fork': {
    id: 'schema.fork',
    argv: ['schema', 'fork'],
    params: [
      { name: 'from', flag: '', kind: 'value', required: true },
      { name: 'to', flag: '', kind: 'value', required: true },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'read-only',
    okExitCodes: [0],
  },

  /**
   * The UNRESOLVED manifest: a pack's own declarations only. The editor needs
   * it to tell "own" from "inherited". Never use it for counts; those come
   * from 'schema.show' + packOverride (S4).
   */
  'schema.showRaw': {
    id: 'schema.showRaw',
    argv: ['schema', 'show'],
    params: [{ name: 'packName', flag: '', kind: 'value', required: true }],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * gbrain's ATOMIC batch mutator, through the trusted local `call` lane:
   * every mutation is validated in memory and the pack file is written at
   * most once (applyMutationsAtomic). A failed batch returns
   * `{error:'mutation_failed', code, failed_at_index, pack_unchanged:true}`,
   * and `call` still exits 0 (S7 step 1), so callers MUST inspect the body.
   * Not the admin MCP lane: no agent grant ever carries this.
   */
  'schema.mutate': {
    id: 'schema.mutate',
    argv: ['call', 'schema_apply_mutations'],
    params: [{ name: 'payload', flag: '', kind: 'value', required: true }],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  'sources.list': {
    id: 'sources.list',
    argv: ['sources', 'list'],
    params: [],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * Permanently delete a source. Per gbrain's own help this CASCADES pages,
   * chunks and embeddings. MEASURED grammar (docs/schema-pack-findings.md S6
   * probe 6): `remove <id> [--yes] [--confirm-destructive] [--dry-run]
   * [--keep-storage]`, and the no-arg call prints exactly
   * `Usage: gbrain sources remove <id> [--yes] [--confirm-destructive] [--dry-run] [--keep-storage]`.
   * We expose `--yes`, `--confirm-destructive` and `--dry-run`, not
   * `--keep-storage`.
   *
   * `--dry-run` is a REAL flag on this command, so it is modelled as an
   * ORDINARY param — NOT via our generic `dryRun` mechanism, which appends
   * `--dry-run` at the END and is gated on `supportsDryRun`. `supportsDryRun`
   * therefore stays false; a caller passes `dryRun: true` among `params`.
   *
   * supportsJson: false — `--json` is accepted but IGNORED; remove prints the
   * same box-drawing impact preview with or without it (MEASURED). Exit codes,
   * both failures so okExitCodes is [0]: a data-bearing source without
   * `--confirm-destructive` exits 5 (`This will permanently delete…`), and a
   * missing source exits 4 (`Source "<id>" not found`).
   */
  'sources.remove': {
    id: 'sources.remove',
    argv: ['sources', 'remove'],
    params: [
      { name: 'id', flag: '', kind: 'value', required: true },
      { name: 'confirmDestructive', flag: '--confirm-destructive', kind: 'flag' },
      { name: 'dryRun', flag: '--dry-run', kind: 'flag' },
      { name: 'yes', flag: '--yes', kind: 'flag' },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * Soft-delete: hide from search, preserve data for 72h. gbrain's help says
   * "For most workflows prefer the soft-delete path", so this is the default
   * the UI offers. MEASURED grammar (S6 probe 6): `archive <id>`; prose only,
   * no `--json`.
   */
  'sources.archive': {
    id: 'sources.archive',
    argv: ['sources', 'archive'],
    params: [{ name: 'id', flag: '', kind: 'value', required: true }],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * Rename the display name only — the id is immutable. MEASURED grammar
   * (S6 probe 6): `rename <id> <new-name>`; prose only, no `--json`.
   * `buildArgv` emits positionals in array order, so `id` must stay first.
   */
  'sources.rename': {
    id: 'sources.rename',
    argv: ['sources', 'rename'],
    params: [
      { name: 'id', flag: '', kind: 'value', required: true },
      { name: 'newName', flag: '', kind: 'value', required: true },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  'sources.status': {
    id: 'sources.status',
    argv: ['sources', 'status'],
    params: [],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  sync: {
    id: 'sync',
    argv: ['sync'],
    params: [
      { name: 'all', flag: '--all', kind: 'flag' },
      { name: 'source', flag: '--source', kind: 'value' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  embed: {
    id: 'embed',
    argv: ['embed'],
    params: [
      { name: 'stale', flag: '--stale', kind: 'flag' },
      // Slice 3: a Connection-scoped embed needs a source fence. Upstream's
      // per-command flag allowlist carries '--source' for `embed`
      // (src/core/cli-flag-registry.generated.ts, 'embed' entry).
      { name: 'source', flag: '--source', kind: 'value' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * F16 — the page-level removal D10's step 3 needs, and the one `sync` cannot
   * substitute for. The reverted page an agent run writes is brain-first: MCP
   * `put_page` creates the row and embeds it inline, and the file is only
   * write-through. A revert's `sync` reconciles the *anchor..HEAD* delta, so a
   * file whose addition and removal both landed inside that delta nets to
   * nothing — MEASURED: after the revert commit `sync --source internal --json`
   * answers `{"sync_status":"up_to_date","deleted":0}` and the reverted page
   * still answers `search`, while `embed --stale` only ever re-embeds. The
   * reverted page therefore has to be removed BY NAME, which is what this verb
   * is for.
   *
   * Measured at the pin (`gbrain delete --help`, plus real calls):
   *   - the slug is POSITIONAL: `delete <slug> --source-id <id> --purge`;
   *   - `--json` is implemented: exit 0 prints
   *     `{status:"purged", slug, source_id, write_through:{removed,path,skipped}, residuals}`
   *     — `write_through.skipped: "file_not_present"` is the reverted shape (the
   *     commit already removed the file), and the caller PARSES this receipt
   *     rather than trusting the flag (L6);
   *   - an absent slug exits 1 with `Error [page_not_found]: …` on STDERR and NO
   *     JSON receipt, which is why the caller reads stderr for that one code;
   *   - `--purge` is honored only for the trusted LOCAL CLI (the op refuses a
   *     remote caller with `permission_denied` and keeps the soft-delete path).
   *     gbrain-ops IS that local CLI, so this verb is reachable exactly here and
   *     nowhere on the MCP surface — note F11: `delete_page` is in a grant's
   *     allowedOperations while the granted SURFACE does not carry it;
   *   - `--source-id` is REQUIRED here, not optional: a multi-source brain can
   *     hold the same slug in several sources and the reverted page belongs to
   *     the write Space's own source. Defaulting to `ctx.sourceId` would purge
   *     the wrong row (the `#4329` failure mode upstream fixed).
   */
  'page.delete': {
    id: 'page.delete',
    argv: ['delete'],
    params: [
      { name: 'slug', flag: '', kind: 'value', required: true },
      { name: 'sourceId', flag: '--source-id', kind: 'value', required: true },
      { name: 'purge', flag: '--purge', kind: 'flag' },
      // 0.51 replaced page mutations with the journaled, revision-checked
      // protocol (upstream PAGE_MUTATION_PARAMS): a delete with no matching
      // expected_revision conflicts, and `--force` explicitly overwrites the
      // current revision. `--force` does NOT exist at 0.50.5.0, so the caller
      // passes it only where the pin supports it (see pin.ts
      // pageDeleteNeedsForce / revert.ts / runner.contract.test.ts). Omitting
      // it leaves the pinned-current argv byte-identical.
      // 0.50.5.0 rejects --force; every caller MUST gate on pageDeleteNeedsForce().
      { name: 'force', flag: '--force', kind: 'flag' },
    ],
    supportsJson: true,
    // `gbrain delete <slug> --purge --dry-run --json` answers
    // `{dry_run:true, action:"purge_page", slug}` and exits 0 (measured), but
    // `--help` does not document it and the revert never asks for a preview of a
    // removal it must actually perform: it is not claimed here.
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * The shipped nightly maintenance cycle: lint, backlinks, extract, sync,
   * embed, synthesize (docs/guides/cron-schedule.md — "schedule THIS instead of
   * hand-rolling the dream cycle"). `--dry-run` previews with no writes and no
   * spend; a real run makes provider calls, so the schedule that owns it
   * carries a --max-usd ceiling.
   */
  dream: {
    id: 'dream',
    argv: ['dream'],
    params: [
      { name: 'source', flag: '--source', kind: 'value' },
      { name: 'phase', flag: '--phase', kind: 'value' },
      { name: 'maxUsd', flag: '--max-usd', kind: 'value' },
      { name: 'yes', flag: '--yes', kind: 'flag' },
    ],
    supportsJson: true,
    supportsDryRun: true,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * The scheduled git-push reconcile deferred from Slice 1. Scan-gated
   * add -> commit -> pull -> push of a Space's workspace repo.
   *
   * Upstream signature (src/commands/sources.ts, runPush): the source id is a
   * POSITIONAL, and --path is its mutually exclusive alternative — passing both
   * is a usage error (exit 2). We only ever pass the id.
   *
   * Exit codes, from the same function's own header comment:
   *   0  pushed, or skipped because a push was already in flight
   *   5  blocked (secrets / tracked deny-glob / unscannable) or refused
   *      (remote not verifiably private)
   *   1  pull conflict / push failure (this is the non-fast-forward path)
   *   2  usage, 4  source not found
   * okExitCodes is [0]: everything else raises an alert. A rejected
   * non-fast-forward is never silently swallowed.
   */
  'sources.push': {
    id: 'sources.push',
    argv: ['sources', 'push'],
    params: [
      { name: 'id', flag: '', kind: 'value', required: true }, // positional
      { name: 'branch', flag: '--branch', kind: 'value' },
      { name: 'message', flag: '--message', kind: 'value' },
      { name: 'allowUnverifiedRemote', flag: '--allow-unverified-remote', kind: 'flag' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * Task 12: free-text retrieval. Dispatched through the shared op table
   * (not the `search modes|stats|tune` dashboard subcommands), so on a
   * thin-client GBRAIN_HOME (see `init.mcpOnly`) this call is transparently
   * routed over MCP as whatever OAuth client owns that config — no
   * GBRAIN_DATABASE_URL needed. Confirmed empirically: querying the same
   * text as two different members' thin clients returns disjoint
   * `source_id` sets that exactly match each member's federated-read grant.
   */
  search: {
    id: 'search',
    argv: ['search'],
    params: [
      { name: 'query', flag: '', kind: 'value', required: true },
      { name: 'limit', flag: '--limit', kind: 'value' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'read-only',
    okExitCodes: [0],
  },

  /**
   * Task 12: identity/scope introspection — works both as gbrain-ops's own
   * local admin (`{"transport":"local","scopes":[]}`) and as a thin client
   * (`{"transport":"oauth","client_id":...,"source_id":...,
   * "federated_read":[...],...}`). Confirmed empirically in both modes
   * against the pinned container; needs no brain-db access either way.
   */
  whoami: {
    id: 'whoami',
    argv: ['whoami'],
    params: [],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'read-only',
    okExitCodes: [0],
  },

  // Slice 1 runs this as the long-lived gbrain-serve entrypoint, not via RPC.
  serve: {
    id: 'serve',
    argv: ['serve'],
    params: [
      { name: 'http', flag: '--http', kind: 'flag' },
      { name: 'bind', flag: '--bind', kind: 'value' },
      { name: 'port', flag: '--port', kind: 'value' },
      { name: 'publicUrl', flag: '--public-url', kind: 'value' },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * U1: NEVER sets a non-zero exit code — not even on a network failure.
   * okExitCodes: [0] here means "0 is the only code this ever emits," not
   * "0 means success." Branch on `.json.error` (src/upgrade/detect.ts),
   * never on exitCode.
   *
   * S3: also a file-plane writer (its `~/.gbrain/last-update-check` cache),
   * so it runs under the ops advisory lock like post-upgrade below.
   */
  checkUpdate: {
    id: 'checkUpdate',
    argv: ['check-update'],
    params: [
      { name: 'refreshCache', flag: '--refresh-cache', kind: 'flag' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'read-only',
    okExitCodes: [0],
    requiresLock: true,
  },

  /**
   * U4/S3: a lock-free read-modify-write of config.json's self_upgrade.*
   * subtree that the autopilot channel races independently. Runs only
   * inside the quiesce window (Task 6), behind ops' own advisory lock —
   * enforced at the RPC boundary in src/ops/server.ts, not left to caller
   * discipline.
   *
   * No --json: post-upgrade has none. Text output only — G3 forbids
   * parsing it; the caller reads the exit code alone.
   */
  postUpgrade: {
    id: 'postUpgrade',
    argv: ['post-upgrade'],
    params: [],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    // Unconfirmed beyond upstream's own "idempotent, safe to re-run any
    // time" and its in-process apply-migrations call, whose own exit codes
    // are 0/1/2 (U3). This operation's contract test is what proves this in
    // practice — patch here with the real number if it ever disagrees.
    okExitCodes: [0],
    requiresLock: true,
  },
};
