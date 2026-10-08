import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.59.0.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. The file changes the evaluation reader default. It does
 * not change the stored brain, and it requires no database migration, provider
 * enrollment, or paid benchmark run. Comparing with a historical receipt is
 * an operator choice of flags, not a host function.
 *
 * Lane already does it (quoted, not a step): "`gbrain --version`" is the run's
 * version check. `gbrain eval longmemeval --help` is not a lane step and is
 * not invented here; confirming the two reader flags is the checklist item.
 *
 * Numbered: 1 preserve receipts; 2 choose reader mode for a new comparison;
 * 3 verify the flags without spending, and do not drop failures from a score.
 */
const UPSTREAM_SHA256 = '7903e547e79ad3429a393d9102a610e2674388bfaa71607431b1cd857b4af939';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v5900-preserve-receipts',
    prompt:
      'Preserve existing LongMemEval receipts and research records. Do not rewrite their prompts, ' +
      'grades, or historical cutoff labels.',
    why:
      'Upstream step 1: "Do not rewrite their prompts, grades or historical cutoff labels." Rewriting ' +
      'evaluation history would invent a mutation the file forbids. There is nothing for a step to apply.',
  },
  {
    key: 'v5900-reader-mode',
    prompt:
      'For a new LongMemEval run, the default is notes-first with a 1024-token cap. If comparing ' +
      'with or resuming a historical direct receipt, pass `--reader-mode direct` and use separate ' +
      'output files. Do not resume across a reader-configuration mismatch, even with ' +
      '`--allow-mixed-run-config`.',
    why:
      'Upstream step 2: "If comparing with or resuming a historical direct receipt, pass ' +
      '`--reader-mode direct`". Whether this install is comparing with a historical receipt is ' +
      'operator judgement. A step cannot see those receipts in UpgradeContext.',
  },
  {
    key: 'v5900-verify-reader-flags',
    prompt:
      'Confirm `gbrain eval longmemeval --help` lists the two reader flags, without spending on ' +
      'provider calls. A cutoff, empty answer, or unknown finish is an incomplete reader error, not ' +
      'an answer eligible for judging. Do not bypass the reader guard or drop failures from a score ' +
      'denominator to recover an old headline number.',
    why:
      'Upstream step 3: "Do not bypass the reader guard or drop failures from a score denominator to ' +
      'recover an old headline number." Verifying help text and refusing to rewrite a score are ' +
      'operator checks. No paid benchmark is authorized.',
  },
];

export const v0_59_0_0: PlaybookSpec = {
  version: '0.59.0.0',
  upstreamSkill: { path: 'skills/migrations/v0.59.0.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
