import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.56.2.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. The file says this patch adds no schema migration and
 * authorizes no live repair, ownership change, paid backfill, or service
 * installation.
 *
 * Lane already does it (quoted, not a step): "GBRAIN_NO_AUTOPILOT_INSTALL=1
 * GBRAIN_NO_REEMBED=1 gbrain upgrade --no-autopilot-install" and, if a phase
 * failed, "`gbrain apply-migrations --yes --no-autopilot-install`". Restart
 * and `gbrain --version` are the run. Our lane does not run `gbrain upgrade`
 * and does not delete a migration ledger.
 *
 * Numbered: 1 drain and backup; 2 inspect a failed phase, do not force a
 * retry blindly; 3 verify writer state and do not activate to bypass a
 * refusal. Embedding migration, retained sync, and the disposable restore are
 * unnumbered operator reviews and are checklist items.
 */
const UPSTREAM_SHA256 = 'e88f04a5deaef82ebb8bd194aec931f26e69e87687098eb64b94666931b5e319';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v5620-drain-and-backup',
    prompt:
      'On a managed deployment, gracefully stop and drain the owner and older workers on every ' +
      'host. Retain the original installation and a verified full database backup. Git alone is not ' +
      'a full database backup.',
    why:
      'Upstream step 1: "Retain the original installation and a verified full database backup. Git ' +
      'alone is not a full database backup." Our quiesce covers this stack. The backup attestation ' +
      'for every host is operator judgement.',
  },
  {
    key: 'v5620-inspect-failed-phase',
    prompt:
      'If an existing migration phase failed, inspect that failure before treating schema work as ' +
      'done. Do not delete its ledger, force a retry blindly, enable capture, or add credentials.',
    why:
      'Upstream step 2: "Do not delete its ledger, force a retry blindly, enable capture or add ' +
      'credentials." Apply-migrations is the lane. Judging the failure and refusing a blind retry ' +
      'is the operator\'s.',
  },
  {
    key: 'v5620-verify-writer-state',
    prompt:
      'After restart, confirm writer status and `gbrain backup check --json`. A source claim is not ' +
      'activation. Do not disable protections or activate persistence just to bypass a refused sync.',
    why:
      'Upstream step 3: "Never disable protections or activate persistence just to bypass a refused ' +
      'sync." Restart and version check are the lane. The backup-check reading and the refusal to ' +
      'bypass protections are operator judgement.',
  },
  {
    key: 'v5620-embedding-migration',
    prompt:
      'Do not assign a new model label to existing vectors or rerun `init` to convert them. Without ' +
      'an explicit model, keep keyword and read-only access and inspect `gbrain migrate embeddings ' +
      '--status --json`. Preview an explicit target with `--dry-run` and obtain approval before ' +
      'migrating. Equal vector widths do not imply compatible models.',
    why:
      'Upstream: "obtain approval before migrating." Changing embedding models is paid work and a ' +
      'model choice. A step that picked a target would invent both.',
  },
  {
    key: 'v5620-sync-and-git',
    prompt:
      'Resume a pending sync with its original source and processing choices. Do not silently ' +
      'reinterpret an unfinished request. Old imports without durable processing choices refuse ' +
      'under their original request ids. Rediscover only after explicit approval, and do not use ' +
      '`--no-schema-pack` to bypass a company-source approval. Do not force-push, include unrelated ' +
      'staging, or rename a source tree. Do not edit frozen requests, terminal receipts, or bookmarks.',
    why:
      'Upstream: "Only after explicit approval" and "Never edit frozen requests, terminal receipts or ' +
      'source bookmarks to manufacture success." Those repairs are operator decisions. Inventing a ' +
      'retry would violate the file.',
  },
  {
    key: 'v5620-disposable-restore',
    prompt:
      'Restore a backup only into an absent disposable root. Reopen it in a fresh process and check ' +
      'remembered pages before relying on it. Keep restored scheduling and connectors inactive until ' +
      'separately approved. The archive is not encrypted and may contain secrets; do not attach it to ' +
      'a public issue. Do not use a live-store experiment or an automatic downgrade for the unresolved ' +
      'macOS reindex hang.',
    why:
      'Upstream: "Restore only into an absent disposable root" and "Keep restored scheduling and ' +
      'connectors inactive until separately approved." A restore drill is operator judgement. This ' +
      'playbook does not run one.',
  },
];

export const v0_56_2_0: PlaybookSpec = {
  version: '0.56.2.0',
  upstreamSkill: { path: 'skills/migrations/v0.56.2.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
