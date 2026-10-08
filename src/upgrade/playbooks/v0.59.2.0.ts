import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.59.2.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. The file changes how `gbrain skillopt` reports a run and
 * requires no database migration, new provider key, or paid call. Changing a
 * cost cap or enabling strict provenance is the user's decision.
 *
 * Lane already does it (quoted, not a step): "`gbrain --version`" is the run's
 * version check. The help and `gbrain models` checks are operator verification,
 * not apply-migrations, restart, or doctor.
 *
 * Numbered: 1 do not remap exit 2 to success; 2 tell the user about
 * `skipped_budget` and do not change the cap; 3 strict provenance only if the
 * user asks; 4 do not change model defaults because of an advisory hint.
 */
const UPSTREAM_SHA256 = 'b6d61af8ef48c154a26e8d427dd6f6570e99efb82b891728426046eea493247b';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v5920-skillopt-exit-2',
    prompt:
      'Tell anyone who wraps `gbrain skillopt` that a run with no usable optimizer reply now ends ' +
      '`errored` with exit code 2, not `no_improvement` with exit 1. Do not remap exit 2 back to ' +
      'success. Read the printed `Fix` line and `Resume:` command, or the receipt\'s `remediation` ' +
      'and `resume_command`.',
    why:
      'Upstream step 1: "Do not remap exit 2 back to success." That is a tell-the-user instruction ' +
      'for scripts this repo does not own. A step that rewrote an exit code would invent the remap ' +
      'the file forbids.',
  },
  {
    key: 'v5920-skillopt-budget',
    prompt:
      'If the nightly dream cycle has `cycle.skillopt.enabled` true, check the latest cycle report ' +
      'for skillopt rows with outcome `skipped_budget`. Tell the user and offer one of the fixes the ' +
      'row lists. Do not change `cycle.skillopt.per_skill_cap_usd`, `skillopt.reflect_max_tokens`, or ' +
      'the deep-tier optimizer without asking.',
    why:
      'Upstream step 2: "Tell the user and offer one of the fixes the row lists. Do not change their ' +
      'cost cap without asking." Changing the cap is a config default and a paid-budget decision. ' +
      'The file does not say to ask before the next maintenance run starts a new paid default; the ' +
      'skill retries only after a setting changes. This item does not block writer resume.',
  },
  {
    key: 'v5920-models-strict',
    prompt:
      'Enable `gbrain config set skillopt.models_strict true` only if the user asks. Otherwise leave ' +
      'it unset. A dry-run of `--models-strict` is optional and only when the user wants it.',
    why:
      'Upstream step 3: "Enable it for every run with `gbrain config set skillopt.models_strict true` ' +
      'only if the user asks." That config change is operator judgement. No step sets it.',
  },
  {
    key: 'v5920-models-hint',
    prompt:
      'Confirm `gbrain skillopt --help` lists `--reflect-max-tokens` and `--models-strict`. Treat ' +
      '`gbrain models` newer-model hints as advisory. Do not change model defaults or tier keys ' +
      'because of a hint unless the user asks.',
    why:
      'Upstream step 4: "The `gbrain models` newer-model hint is advisory. Do not change model ' +
      'defaults or tier keys because of it unless the user asks." Changing a model default would ' +
      'invent a provider choice the file leaves to the user.',
  },
];

export const v0_59_2_0: PlaybookSpec = {
  version: '0.59.2.0',
  upstreamSkill: { path: 'skills/migrations/v0.59.2.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
