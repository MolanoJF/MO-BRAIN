import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.52.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. This deployment is already Postgres. A PGLite-to-Postgres
 * graduation stops at exit 3 until the user agrees. The file says never run
 * the move without that agreement. UpgradeContext has no target URL.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it" and
 * "`gbrain apply-migrations --yes --no-autopilot-install`". The graduation
 * table is that schema step. Our lane does not run `gbrain upgrade` or
 * `gbrain migrate`.
 *
 * Numbered: 1 lane schema; 2 move the URL out of the command line; 3 plan and
 * ask; 4 run only after agreement; 5 status, resume, and deleting the old
 * data dir is the user's call. No blocksResume.
 */
const UPSTREAM_SHA256 = 'ae49b2f51ba6288e4883d8bfda9f494f821e160e227164aa065a645d4e9ae87b';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60520-graduation',
    prompt:
      'This brain is already Postgres. Do not run `gbrain migrate --to postgres` from this upgrade. ' +
      'If a PGLite brain is in scope, the bare command stops at exit 3 and changes nothing. Ask the ' +
      'user to put the target URL in `GBRAIN_TARGET_URL` and use `--url-env`. Relay `user_message` ' +
      'and the what-moves / what-stays lists, then stop until they agree. Run `fix.command` with ' +
      '`--yes --expect <plan_hash>` only after that. `preview_changed` means plan and ask again. ' +
      'Deleting `<path>.graduated-<run_id>` is the user\'s call. ' +
      '`gbrain config set migrate.graduation false` sends the move through the legacy copier, which ' +
      'refuses brains with write history. Do not set it to force a copy.',
    why:
      'Upstream: "Never run the move without the user\'s agreement." And "The bare command stops at ' +
      'exit 3 for every PGLite to Postgres move ... and changes nothing." The move is operator ' +
      'judgement. A step that passed `--yes` would invent the confirmation. This Postgres deployment ' +
      'does not start that move. No blocksResume.',
  },
];

export const v0_60_52_0: PlaybookSpec = {
  version: '0.60.52.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.52.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
