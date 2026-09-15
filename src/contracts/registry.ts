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
};
