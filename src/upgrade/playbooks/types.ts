import type { UpgradeContext } from '../types.ts';

/**
 * A deterministic, hand-written, reviewed-like-code step. It either completes
 * or it throws — there is no partial success and no warn-and-continue, because
 * a step that can only be attempted is a checklist item (G5, honesty rule 6).
 *
 * Steps run on the HOST inside scripts/upgrade.ts (D1) while the stack is
 * quiesced and gbrain-ops is the only gbrain process alive. They must be
 * idempotent: a resumed run re-executes them.
 */
export type PlaybookStep = {
  id: string;
  description: string;
  run(ctx: UpgradeContext): Promise<void>;
};

/** Judgement residue. A human decides it; nothing in this repo ever does. */
export type ChecklistItemSpec = {
  /** Stable slug. It is the idempotency key for a resumed run's checklist. */
  key: string;
  /** What the human is being asked to decide. */
  prompt: string;
  /** Why this is a decision and not a step — quote upstream where possible. */
  why: string;
  /**
   * Absent means false. When true, `run` leaves the writers down after the
   * gate and does not enter `completed` until `resume-writers`.
   */
  blocksResume?: true;
  /**
   * Allowlisted ops RPC applied when the admin declines. Absent means a
   * decline still blocks writer resume — there is no opt-out to apply.
   * `params` values are strings passed as RPC fields, never a shell string.
   */
  declineOp?: { op: string; params: Record<string, string> };
};

/** Provenance of the exact upstream file version that was hand-translated. */
export type UpstreamSkillRef = { path: string; sha256: string };

/**
 * Exactly two kinds of content, and no third bucket a "best effort" step could
 * hide in. Either the version carries a reviewed, hand-written spec with the
 * provenance of the upstream file it was translated from, or it carries an
 * explicit statement that upstream ships no playbook for it, with the evidence
 * that established it (D6, honesty rule 6/7).
 */
export type PlaybookSpec =
  | {
      version: string;
      upstreamSkill: UpstreamSkillRef;
      steps: PlaybookStep[];
      checklist: ChecklistItemSpec[];
      noPlaybookRequired?: false;
    }
  | {
      version: string;
      noPlaybookRequired: true;
      /** How we know upstream ships nothing here. Named in the ledger row. */
      evidence: string;
    };

export function hasPlaybook(
  spec: PlaybookSpec,
): spec is Extract<PlaybookSpec, { steps: PlaybookStep[] }> {
  return !('noPlaybookRequired' in spec && spec.noPlaybookRequired);
}
