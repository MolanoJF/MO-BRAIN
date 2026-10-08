import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.63.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Retrieval feedback is off until the user opts in. The file
 * says nothing changes until they do. No blocksResume.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it" and
 * "`gbrain apply-migrations --yes --no-autopilot-install`". "`gbrain doctor
 * --only retrieval_feedback_health`" is the run's doctor. Our lane does not
 * run `gbrain upgrade` and does not set `feedback.enabled`.
 *
 * Numbered: 1 lane schema; 2 relay the notice and ask; 3 cardinality preview
 * before activating a pack that declares one; 4 verify.
 */
const UPSTREAM_SHA256 = 'cdc9f862a719bdb76140b5069fb659987978bc2d90498d808bc5d766dbf16891';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60630-retrieval-feedback',
    prompt:
      'Show the user the one-time post-upgrade [AGENT] block about retrieval feedback and ask ' +
      'whether to turn it on. Only after they say yes: `gbrain config set feedback.enabled true`. ' +
      'With it on, answers carry an `answer_id` to rate. Ratings nudge ranking by at most 0.9x to ' +
      '1.1x. Tell them held-out tests showed a gain on entity-centric brains and none on ' +
      'chat-history brains. Do not enable it from this upgrade.',
    why:
      'Upstream step 2: "Show the user its message and ask whether to turn it on. Only after they say ' +
      'yes: `gbrain config set feedback.enabled true`." The header says "Nothing changes for the user ' +
      'until they opt in." Setting the key is operator judgement. No step sets it.',
  },
  {
    key: 'v60630-cardinality',
    prompt:
      'A schema pack can mark a state relation `cardinality: one_per_from`. The nightly ' +
      '`edge_contradictions` phase then proposes closures for that type without a model call. Nothing ' +
      'is written until the user accepts one. No bundled pack declares a cardinality. Before ' +
      'activating a pack that does, run `gbrain schema cardinality-preview` and ' +
      '`gbrain edge-proposals list`. Do not activate such a pack from this upgrade.',
    why:
      'Upstream step 3: "Before activating a pack that does" preview cardinality and list proposals. ' +
      'Activating a pack is a schema decision. No step activates one. Doctor and `gbrain feedback ' +
      'status` remain operator reads; doctor itself is the lane.',
  },
];

export const v0_60_63_0: PlaybookSpec = {
  version: '0.60.63.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.63.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
