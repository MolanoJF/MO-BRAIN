/**
 * D5 — the closed tool allowlist. This is the ONLY place `--allowedTools` is
 * computed, and it is computed as an INTERSECTION of two things:
 *
 *   1. a hand-written product allowlist (below), so an upstream tool ADDITION
 *      cannot silently widen the surface an autonomous agent holds; and
 *   2. the tool catalog at the running pin (`capability_snapshots.tools_json`,
 *      captured by `gbrain --tools-json`), so an upstream REMOVAL cannot leave
 *      a dangling grant naming a tool that no longer exists.
 *
 * **F11 is why the second input is the catalog and never the grant.** The
 * intersection is honest about existence; it cannot be honest about
 * authorization, because `mcp grant`'s `allowedOperations` lists operations the
 * granted MCP SURFACE does not carry — the probe measured `delete_page` there
 * (`"error":"unknown_operation","message":"Unknown: delete_page"`) while it is
 * listed as allowed. Measured at the pin, `capability_snapshots.tools_json` holds
 * the FULL catalog (`gbrain --tools-json`: 136 operations at 0.50.x, `delete_page`
 * among them) while a single Connection's grant sees the `surface: "starter"`
 * subset (`tools/list`: 21). So the product allowlist below is curated against
 * that measured SURFACE, and `delete_page` is absent from it for exactly that
 * reason. Naming a tool the server rejects is a run that burns its budget
 * learning the lesson.
 *
 * **What this is not.** Honesty rule 2: `--allowedTools` (and the harness's own
 * deny-list) are defence in depth, never the fence. The fence is D6's
 * `internal: true` network, asserted from inside the running container.
 *
 * Empty is a legal result — an empty snapshot, or a pin whose catalog lost every
 * tool we would grant. Task 8's `buildHarnessArgv` is where that becomes a
 * refusal rather than a harness with no tools, so the run ends `refused` with an
 * alert: loud, but later than a claim-time refusal. The operational consequence
 * is worth naming rather than discovering: a deployment with NO
 * `capability_snapshots` row at the running pin has no allowlist to hand out, and
 * the capture lane (`bun run capability:capture`, or an upgrade leg's import) is
 * what supplies one.
 */
import { toolNames, type CapabilitySnapshot } from '../contracts/capability.ts';

/**
 * The MCP server name the runner's `--mcp-config` declares. The harness
 * qualifies every tool as `mcp__<server>__<tool>` (P4-c: `mcp__gbrain__put_page`),
 * and gbrain's own `serverInfo.name` is `gbrain`.
 */
export const MCP_SERVER_NAME = 'gbrain';

/** `mcp__gbrain__` — the one place this prefix is spelled. */
export const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * The product's allowlist: what an autonomous run is for — read the pages it was
 * pointed at, and write the one page it was asked to write. Every name here is
 * on the `starter` surface measured in P7/P8; the graph-write ops
 * (`add_link`/`remove_link`), the memory verbs (`forget`, `purge_deleted_pages`)
 * and the admin lane are deliberately absent.
 */
export const PRODUCT_TOOL_ALLOWLIST: readonly string[] = [
  'search',
  'query',
  'get_page',
  'list_pages',
  'get_backlinks',
  'traverse_graph',
  'put_page',
];

/**
 * The allowlist's write tools. A Connection compiled from the `memory-reader`
 * profile has `cap:read` and no `cap:write` (`src/contracts/compile.ts`), so
 * granting it `put_page` would be a grant the server denies — a root cause that
 * would surface as an opaque tool error mid-run instead of at claim time.
 */
const WRITE_TOOLS: readonly string[] = ['put_page'];

/**
 * The intersection, fully qualified for `--allowedTools`, sorted so the claim is
 * byte-identical across runs.
 *
 * `snapshot` is the capability snapshot at the running pin
 * (`latestSnapshotFor(db, GBRAIN_PIN)`); a missing or unreadable one yields the
 * empty list rather than a guess — the catalog is the half of the intersection
 * we cannot invent.
 */
export function allowedToolsFor(
  connection: { profile?: string | null } | null | undefined,
  snapshot: CapabilitySnapshot | null | undefined,
): string[] {
  const catalog = new Set(toolNames(snapshot?.tools ?? null));
  const readOnly = connection?.profile === 'memory-reader';
  return PRODUCT_TOOL_ALLOWLIST
    .filter((tool) => catalog.has(tool))
    .filter((tool) => !(readOnly && WRITE_TOOLS.includes(tool)))
    .map((tool) => `${TOOL_PREFIX}${tool}`)
    .sort();
}
