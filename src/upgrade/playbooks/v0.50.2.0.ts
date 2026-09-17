import { cmpVersion } from './index.ts';
import type { ChecklistItemSpec, PlaybookSpec, PlaybookStep } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.50.2.0.md`, read in full once at
 * the digest recorded below, in the v0.50.5.0 tree. The plan's draft doc
 * comment claimed that file has "exactly two numbered steps"; that was wrong —
 * it has EIGHT. All eight are accounted for below, one bucket each.
 *
 * This delta ships NO schema migration (migrate.ts, the operation registry and
 * the schema packs are byte-identical across v0.50.0.0 -> v0.50.5.0), so the
 * schema-relevant wording in the file is a known no-op here. That is not a
 * licence to drop steps: it is why the deterministic half is short and the
 * judgement half is long.
 *
 * G5 admits no third bucket. Step 1's version comparison is mechanical, so it
 * is a PlaybookStep. Everything else — including step 1's clause about whether
 * the v0.50.0.0 cutover actually happened on THIS database — is judgement, a
 * human-only action, or an instruction our lane must NOT execute (step 2's
 * `gbrain upgrade`; step 5's paid embedding), so it is a checklist item that
 * quotes upstream and says why a human decides it.
 */
const UPSTREAM_SHA256 = 'ff1aab621479eeda5f210e026169ba584a1c402536cabddc7c387a617934b6f1';

const steps: PlaybookStep[] = [
  {
    id: 'assert-starting-version',
    description:
      'Upstream step 1: refuse to apply the 0.50.2.0 file to an install older than 0.50.0.0. ' +
      'That case must go through the 0.50.0.0 coordinated authorization cutover first.',
    async run(ctx) {
      if (cmpVersion(ctx.fromVersion, '0.50.0.0') < 0) {
        throw new Error(
          `v0.50.2.0 refuses a start at ${ctx.fromVersion}: skills/migrations/v0.50.2.0.md step 1 ` +
          'requires the 0.50.0.0 coordinated cutover first. Upgrade to 0.50.0.0 as its own run, ' +
          "resolve the job queue as that file's steps describe, then re-run this one.",
        );
      }
    },
  },
];

const checklist: ChecklistItemSpec[] = [
  {
    key: 'pre-0-50-0-0-cutover-attested',
    prompt:
      'This install reports a starting version of 0.50.0.0 or later. Confirm that the 0.50.0.0 ' +
      'coordinated authorization cutover (skills/migrations/0.50.0.0.md) was completed against ' +
      'THIS database, or that this brain was provisioned at 0.50.0.0 or later.',
    why:
      'Upstream step 1 and the 0.50.0.0 file require every nonterminal historical job to be reviewed ' +
      'or cancelled before restart, and no published contract reports whether that review happened. ' +
      'Our ledger cannot answer it either: playbook_ledger has never been written before this slice, ' +
      'so there is no row to read. A human who knows the install answers this; no code can.',
  },
  {
    key: 'upstream-step-2-host-upgrade',
    prompt:
      'Upstream step 2 says: run `gbrain upgrade`, restart its services, then run `gbrain --version` ' +
      'and `gbrain doctor`; if doctor reports a partial earlier migration, inspect the exact failure ' +
      'and use the existing migration recovery procedure rather than a destructive cleanup or bulk ' +
      'job authorization. Confirm the host outcome.',
    why:
      'Our lane NEVER runs `gbrain upgrade` — the product owns the upgrade lane and swaps images — ' +
      'and service restart plus doctor parity are the run\'s own steps, not a playbook\'s. What ' +
      'remains, judging a partial-migration report and choosing recovery, is operator judgement that ' +
      'G5 forbids encoding as code.',
  },
  {
    key: 'upstream-step-3-pglite-holders',
    prompt:
      'Upstream step 3 says to stop and restart the owning service normally so the new lock records ' +
      'structured arguments, and never to delete a live lock or run two processes against the same ' +
      'embedded database. Confirm there are no PGLite holders on this host, or that they were ' +
      'restarted normally.',
    why:
      'The instruction is about PGLite lock identity and explicitly warns that unprovable live ' +
      'identity refuses automatic reaping; choosing to restart or to abandon a process is operator ' +
      'judgement, and deleting a live lock is a destructive act no deterministic step may take.',
  },
  {
    key: 'upstream-step-4-hosted-launchers',
    prompt:
      'Upstream step 4 says to rerun the original installed launcher workflow for any recorded ' +
      'launcher that still exports a write source or passes `--brain host`, using the existing ' +
      'private handoff and installation root, without minting a broader grant. Confirm which ' +
      'launchers, if any, were repaired.',
    why:
      'Identifying the recorded launcher, holding the private handoff, and deciding what stays in ' +
      'scope is a human authorization decision; the file says not to expand access, so a step that ' +
      'guessed at it would be unsafe, and `gbrain call` is intentionally host-only.',
  },
  {
    key: 'upstream-step-5-code-source-walk',
    prompt:
      'Upstream step 5 says to name the source whose Bash parsing or Windows subdirectory sync ' +
      'failed, back up its files, run a source-scoped full sync with `--no-embed`, and review the ' +
      'remaining embedding work with the operator before paying for it. Confirm the affected source ' +
      'and its recovery.',
    why:
      'Which source was affected, whether its files are backed up, and whether to authorize paid ' +
      'embedding is a judgement call the file itself defers to the operator ("review the remaining ' +
      'embedding work with the operator"), so it cannot be a step that runs unattended.',
  },
  {
    key: 'upstream-step-6-unattached-facts',
    prompt:
      'Upstream step 6 says unresolved references keep their fact and provenance with a NULL entity ' +
      'target, the legacy fence migration reports `skipped_no_page` instead of inventing pages, and ' +
      'historical orphan facts are not repaired automatically; keep a restorable database backup as ' +
      'well as source backups. Confirm no entity pages were invented to clear a diagnostic.',
    why:
      'The requirement is a preservation decision — do not delete DB-only facts and do not invent ' +
      'entity pages — and the only mechanical half, a restorable backup, is the run\'s snapshot, not ' +
      'a per-version action; judging whether a fact is still needed is human.',
  },
  {
    key: 'upstream-step-7-write-results',
    prompt:
      'Upstream step 7 says `storage_busy` means the write was not applied and not queued, a saved ' +
      'page may separately report embedding failure or supersession, and a `require_writes: true` ' +
      'job must actually save a page; inspect `gbrain jobs stats --json` and the relevant job ' +
      'results before restoring unattended schedules. Confirm the schedules were reviewed.',
    why:
      'Reading a job\'s result and deciding that an unattended schedule is safe to restore is a ' +
      'prediction about future writes, not a deterministic transformation of UpgradeContext, so it ' +
      'is judgement residue a human decides.',
  },
  {
    key: 'upstream-step-8-oauth-scopes',
    prompt:
      'Upstream step 8 says a generic client starts with `read`, saving needs an explicit authorized ' +
      '`write` request and operator approval, existing authorized sessions must be preserved, and ' +
      'SDK/HTTP tests are not evidence of a live ChatGPT or Claude session. Confirm the intended ' +
      'harness was verified without broadening scopes.',
    why:
      'The file says to verify the intended harness separately and not to purge tokens or re-register ' +
      'every client; whether a live session actually works is an external observation only a human ' +
      'or a separate end-to-end check can make, not a playbook step.',
  },
];

export const v0_50_2_0: PlaybookSpec = {
  version: '0.50.2.0',
  upstreamSkill: { path: 'skills/migrations/v0.50.2.0.md', sha256: UPSTREAM_SHA256 },
  steps,
  checklist,
};
