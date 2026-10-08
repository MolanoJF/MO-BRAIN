import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.52.1.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No numbered list and no PlaybookStep. The file says this release does not
 * require activating a new writer topology, and it authorizes no paid embedding.
 *
 * Lane already does it (quoted, not a step): "GBRAIN_NO_AUTOPILOT_INSTALL=1
 * GBRAIN_NO_REEMBED=1 gbrain upgrade --no-autopilot-install". Our lane does
 * not run `gbrain upgrade`. Image swap, apply-migrations with
 * noAutopilotInstall, and restart are the run. "If upgrading from before
 * v0.51.7.0, also read its projection-readiness guidance" is the v0.51.7.0
 * playbook when that version is in the window, not a second command.
 */
const UPSTREAM_SHA256 = '7b54ff2e4e881658020d725aa1709f10b34e118974e1899c4c46aca3712409a1';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v5210-no-paid-embeddings',
    prompt:
      'Confirm paid embeddings were not enabled to clear a readiness warning. Keep optional ' +
      'provider and daemon work opt-in. Disabled primary embeddings do not need destructive ' +
      'reinitialization to make diagnostics pass.',
    why:
      'Upstream: "Do not enable paid embeddings just to make a readiness warning disappear." Paid ' +
      'work is a checklist item. A step that enabled embeddings would invent the spend the file forbids.',
  },
  {
    key: 'v5210-opaque-fetch-id',
    prompt:
      'Pass each search result\'s `id` unchanged to `fetch`. On `ambiguous_id`, search again; do not ' +
      'choose an arbitrary source. On a missing page, check current access and page state rather ' +
      'than retrying another source.',
    why:
      'Upstream: "On `ambiguous_id`, search again; do not choose an arbitrary source." Picking a ' +
      'source is operator judgement. There is no host function that can make that choice.',
  },
  {
    key: 'v5210-no-topology-change',
    prompt:
      'Confirm ordinary diagnosis, startup, and maintenance did not claim a checkout, activate ' +
      'managed mode, or transfer ownership. A separately approved topology change must supply the ' +
      'exact `--admin-intent` and the unchanged `--expected-state` from reviewed status. Do not ' +
      'refresh the fingerprint automatically to overcome a refusal.',
    why:
      'Upstream: "Ordinary diagnosis, startup and maintenance must not claim a checkout, activate ' +
      'managed mode or transfer ownership." Those are operator authorizations. A terminal or generic ' +
      '`--yes` is not a substitute.',
  },
  {
    key: 'v5210-verify-search-and-fact',
    prompt:
      'Search for a known phrase and fetch its returned id. Read a saved fact and its provenance ' +
      'after a process restart. Inspect writer status before and after routine repair and confirm ' +
      'owner identities and epochs did not change solely because of diagnosis.',
    why:
      'Upstream: "Owner identities and epochs should not change solely because of diagnosis." ' +
      'Verifying a known page and a live fact is an observation only the operator can make. It is ' +
      'not a function of UpgradeContext.',
  },
  {
    key: 'v5210-pglite-hang-unproven',
    prompt:
      'Treat the reported macOS PGLite reindex hang as unproven. On failure, retain sanitized ' +
      'diagnostics and use the existing database access repair loop. Do not delete ownership markers ' +
      'or bypass the designated writer. This Postgres deployment does not run that PGLite repair.',
    why:
      'Upstream: "The reported macOS PGLite reindex hang remains unproven" and "without deleting ' +
      'ownership markers or bypassing the designated writer." That notice is checklist text. It is ' +
      'not a blocksResume hold and not a step.',
  },
];

export const v0_52_1_0: PlaybookSpec = {
  version: '0.52.1.0',
  upstreamSkill: { path: 'skills/migrations/v0.52.1.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
