import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.44.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Keeping full MCP rows is a config change the user agrees
 * to. The file says nothing spends money and no schema migration runs.
 *
 * Lane already does it (quoted, not a step): "Restart every `gbrain serve`
 * after upgrading" is the run's restart. "`gbrain doctor`" is the run.
 * "`gbrain config get mcp.result_rows`" is an operator read, not a step.
 *
 * Numbered: 1 restart is the lane; 2 know the lean row shape and set
 * `mcp.result_rows full` only with agreement; 3 shorter tool descriptions;
 * 4 doctor is the lane.
 */
const UPSTREAM_SHA256 = '415d05b4587e49c7bdad40b55878b0b50f5330915a5e49065638fb6680ced3fe';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60440-result-rows',
    prompt:
      'Tell remote MCP callers that `search` and `query` rows are now lean unless the call passes ' +
      '`fields: "full"`. Ranking diagnostics are omitted. If a script reads a dropped field, keep ' +
      'the old rows for every remote caller only with the user\'s agreement: ' +
      '`gbrain config set mcp.result_rows full`, then restart `gbrain serve`. Do not set that key ' +
      'from this upgrade. An older thin CLI gets lean rows until it is upgraded or the host sets the key.',
    why:
      'Upstream step 2: "keep the old rows for every remote caller with the user\'s agreement". ' +
      'Setting `mcp.result_rows` changes an operator default. No step sets it. Restart is the lane.',
  },
  {
    key: 'v60440-tool-descriptions',
    prompt:
      'Expect shorter starter-tool descriptions. The longer guidance is in `docs/mcp/TOOL_REFERENCE.md`. ' +
      'Notices under search results are capped, with a `(+N more)` count. `recall` still returns the ' +
      'full set of facts. Empty `mcp.result_rows` means lean rows for remote callers.',
    why:
      'Upstream step 3: "Expect shorter tool descriptions." That is tell-the-user. Doctor is the ' +
      'lane. No step rewrites a client to read dropped fields.',
  },
];

export const v0_60_44_0: PlaybookSpec = {
  version: '0.60.44.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.44.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
