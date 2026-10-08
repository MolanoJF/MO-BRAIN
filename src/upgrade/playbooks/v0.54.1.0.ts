import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.54.1.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Repairs, paid embedding, and `--force-retry` are operator
 * decisions. The file says this release adds recovery capabilities and does
 * not authorize their execution.
 *
 * Lane already does it (quoted, not a step): "GBRAIN_NO_AUTOPILOT_INSTALL=1
 * GBRAIN_NO_REEMBED=1 gbrain upgrade --no-autopilot-install". Our lane does
 * not run `gbrain upgrade`. "Restart the upgraded owners/workers and verify
 * `gbrain --version`" is the run's restart and version check.
 *
 * Numbered: 1 drain and backup; 2 no side effects and no blind force-retry;
 * 3 review topology before scheduling. Sync retry, embed --stale --facts,
 * PGLite atom drain, OpenClaw slot migration, and the backup drill are
 * unnumbered operator actions and are checklist items.
 */
const UPSTREAM_SHA256 = 'ceee87cfc7bb28036e9cadb5b70b7ec9eabcce6d445e259f3ee410a95fe69603';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v5410-drain-and-backup',
    prompt:
      'On a managed brain, identify and gracefully stop and drain the owner and older workers on ' +
      'every host. Keep a verified full database backup and the original installation. A Git remote ' +
      'alone is not a full backup. Do not mix old consumers with the new durable intent types.',
    why:
      'Upstream step 1: "Keep a verified full database backup and the original installation. A Git ' +
      'remote alone is not a full backup." Our quiesce covers this stack. Other hosts and the ' +
      'backup attestation are operator judgement.',
  },
  {
    key: 'v5410-no-side-effects',
    prompt:
      'Confirm the upgrade did not add credentials, enable capture, install services, or start a ' +
      'paid backfill. If a migration reports a failed phase, inspect it. A partial result is not ' +
      'completion. Do not delete the ledger. Use an explicit reviewed `--force-retry` only for a ' +
      'historical false-complete entry, not as a blanket retry.',
    why:
      'Upstream step 2: "Do not add credentials, enable capture, install services or start a paid ' +
      'backfill as an upgrade side effect." And "Historical false-complete migration entries need an ' +
      'explicit reviewed `--force-retry`, not blanket ledger deletion." `--force-retry` is not the ' +
      'lane\'s apply-migrations. It is operator judgement.',
  },
  {
    key: 'v5410-review-topology',
    prompt:
      'After restart, review source topology and `unsupported_maintenance` before scheduling work. ' +
      'A claim alone is not completed onboarding. Do not manufacture a fresh expected-state value ' +
      'to overcome a refusal. Follow the writer-administration procedure for a deliberate claim, ' +
      'activation, or self-transfer.',
    why:
      'Upstream step 3: "never manufacture fresh expected-state values automatically just to ' +
      'overcome a refusal." Restart and `gbrain --version` are the lane. The topology review is ' +
      'operator judgement.',
  },
  {
    key: 'v5410-sync-retry',
    prompt:
      'For a stalled Git-backed or connector sync, fix the reported source problem first, inspect ' +
      'the failed run, then approve `gbrain sync --source <id> --retry-failed` with the same options. ' +
      'Do not use `--skip-failed` on managed cursors. Do not treat a successful full run as repairing ' +
      'a separate failed incremental run. Cancelled receipts stay cancelled.',
    why:
      'Upstream: "approve `gbrain sync --source source-example --no-pull --retry-failed`" and "Do not ' +
      'use `--skip-failed` on managed cursors". Retrying a failed sync is a repair. Naming the source ' +
      'and approving it is operator judgement.',
  },
  {
    key: 'v5410-embed-facts',
    prompt:
      'Preview missing fact vectors with `gbrain embed --stale --facts --source <id> --dry-run --json`. ' +
      'Run the bounded execution only after the operator approves the source, count, and budget. A ' +
      'lost resident acknowledgment needs another preview, not an automatic paid retry.',
    why:
      'Upstream names `gbrain embed --stale --facts` and says "After the operator approves the source, ' +
      'count and budget". Paid embedding is a checklist item. A step must not spend.',
  },
  {
    key: 'v5410-pglite-atom-drain',
    prompt:
      'PGLite atom recovery, if this install is PGLite, stops its owner, runs the reviewed ' +
      '`jobs submit extract-atoms-drain` command, and restarts the owner. Inspect the job id. Do not ' +
      'resubmit a failed job, which is a new extraction approval. This Postgres deployment does not ' +
      'run that drain. An expired payload is not work that never ran and must not trigger automatic ' +
      'repeat model spending.',
    why:
      'Upstream: "Do not infer live-owner dream/jobs delegation" and "must not trigger automatic ' +
      'repeat model spending." The drain is PGLite-only checklist text, not blocksResume, and not a ' +
      'step on this Postgres deployment.',
  },
  {
    key: 'v5410-openclaw-and-backup',
    prompt:
      'If an OpenClaw installation uses the legacy `gbrain-context` slot, migrate that selection to ' +
      '`gbrain-context-engine` only inside that installation, preserving unrelated settings. Do not ' +
      'guess `workspaceDir` from the gateway working directory. Run `gbrain backup check --json` and ' +
      'a disposable full restore drill before relying on a backup. Do not downgrade a datastore that ' +
      'contains new accepted requests.',
    why:
      'Upstream: "never guess from the gateway\'s working directory" and "perform a disposable full ' +
      'restore drill before relying on a backup." Both are operator checks. Guessing a path or ' +
      'downgrading the datastore would invent behavior the file forbids.',
  },
];

export const v0_54_1_0: PlaybookSpec = {
  version: '0.54.1.0',
  upstreamSkill: { path: 'skills/migrations/v0.54.1.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
