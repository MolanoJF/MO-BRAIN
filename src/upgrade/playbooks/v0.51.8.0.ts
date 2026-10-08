import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.51.8.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No numbered list and no PlaybookStep. The file's imperatives are "do not
 * change the operator's chosen search mode", do not activate optional company
 * features, stop on a missing-origin diagnostic, and do not switch vocabulary.
 *
 * Lane already does it (quoted, not a step): "The upgrade orchestrator applies
 * migration 162. If it did not complete, run `gbrain apply-migrations --yes`
 * on the intended brain host, then `gbrain doctor`."
 */
const UPSTREAM_SHA256 = '16af7c14f4ee12029b87ee2f07446a6355216ddf6109f54c2fcc0adbd558b09a';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v5180-preserve-search-mode',
    prompt:
      'Confirm this upgrade did not initialize another brain and did not change the operator\'s ' +
      'chosen search mode.',
    why:
      'Upstream: "Do not initialize another brain or change the operator\'s chosen search mode." ' +
      'That preservation is a human check. Inventing a config write would change the default the ' +
      'file says to leave alone.',
  },
  {
    key: 'v5180-company-schema-opt-in',
    prompt:
      'Do not activate the company schema, connect a repository, or run `unify-types` merely ' +
      'because the optional company features are installed. Existing source files, page types, and ' +
      'grants do not need rewriting.',
    why:
      'Upstream: "Do not activate the company schema, connect a repository, or run `unify-types` ' +
      'merely because the optional company features are installed." Activating them is operator ' +
      'judgement, not a step.',
  },
  {
    key: 'v5180-link-extraction-stop',
    prompt:
      'If link extraction reports missing legacy origin metadata, stop and show the operator that ' +
      'diagnostic. Do not delete all links or invent provenance to force the extraction through.',
    why:
      'Upstream: "If it reports missing legacy origin metadata, stop and show the operator that ' +
      'diagnostic. Do not delete all links or invent provenance to force the extraction through." ' +
      'Showing the diagnostic is "tell the user". Deleting links would be an invented destructive step.',
  },
  {
    key: 'v5180-typed-query-diagnosis',
    prompt:
      'If a typed query refuses because the selected schema cannot be read, diagnose the actual ' +
      'selected engine and schema. Do not switch the query to the host\'s vocabulary to make it pass.',
    why:
      'Upstream: "Typed queries now refuse when the selected schema cannot be read. Diagnose the ' +
      'actual selected engine/schema instead of switching to the host\'s vocabulary." Choosing a ' +
      'different vocabulary is operator judgement.',
  },
];

export const v0_51_8_0: PlaybookSpec = {
  version: '0.51.8.0',
  upstreamSkill: { path: 'skills/migrations/v0.51.8.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
