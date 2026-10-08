import { v0_50_2_0 } from './v0.50.2.0.ts';
import { v0_51_0_0 } from './v0.51.0.0.ts';
import { v0_51_7_0 } from './v0.51.7.0.ts';
import { v0_51_8_0 } from './v0.51.8.0.ts';
import { v0_52_1_0 } from './v0.52.1.0.ts';
import { v0_52_2_0 } from './v0.52.2.0.ts';
import { v0_53_0_0 } from './v0.53.0.0.ts';
import { v0_54_1_0 } from './v0.54.1.0.ts';
import { v0_56_2_0 } from './v0.56.2.0.ts';
import { v0_58_0_0 } from './v0.58.0.0.ts';
import { v0_59_0_0 } from './v0.59.0.0.ts';
import { v0_59_2_0 } from './v0.59.2.0.ts';
import { v0_59_10_0 } from './v0.59.10.0.ts';
import { v0_60_5_0 } from './v0.60.5.0.ts';
import { v0_60_6_0 } from './v0.60.6.0.ts';
import { v0_60_11_0 } from './v0.60.11.0.ts';
import { v0_60_20_0 } from './v0.60.20.0.ts';
import { v0_60_26_0 } from './v0.60.26.0.ts';
import { v0_60_27_0 } from './v0.60.27.0.ts';
import { v0_60_28_0 } from './v0.60.28.0.ts';
import { v0_60_30_0 } from './v0.60.30.0.ts';
import { v0_60_31_0 } from './v0.60.31.0.ts';
import { v0_60_36_0 } from './v0.60.36.0.ts';
import { v0_60_37_0 } from './v0.60.37.0.ts';
import { v0_60_44_0 } from './v0.60.44.0.ts';
import { v0_60_45_0 } from './v0.60.45.0.ts';
import { v0_60_47_0 } from './v0.60.47.0.ts';
import { v0_60_52_0 } from './v0.60.52.0.ts';
import { v0_60_53_0 } from './v0.60.53.0.ts';
import { v0_60_57_0 } from './v0.60.57.0.ts';
import frozenReleases from './released-0.60.104.0.json' with { type: 'json' };
import type { PlaybookSpec } from './types.ts';

export type { ChecklistItemSpec, PlaybookSpec, PlaybookStep, UpstreamSkillRef } from './types.ts';
export { hasPlaybook } from './types.ts';

/** Four numeric components, exactly. A moving tag is not a version (G1). */
const VERSION_RE = /^\d+\.\d+\.\d+\.\d+$/;

export function cmpVersion(a: string, b: string): -1 | 0 | 1 {
  for (const v of [a, b]) {
    if (!VERSION_RE.test(v)) throw new Error(`${v} is not a four-part version`);
  }
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i += 1) {
    const x = pa[i]!;
    const y = pb[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export type ReleasedVersion = { version: string; evidence: string };

/**
 * The versions upstream ACTUALLY released, in order, each with the evidence
 * that established it. This list — not an arithmetic range — is what
 * playbooksFor enumerates.
 *
 * Incrementing the last component from `from` to `to` would demand a 0.50.3.0
 * entry, and 0.50.3.0 does not exist: upstream's CHANGELOG at the v0.50.5.0 pin
 * jumps [0.50.2.0] -> [0.50.4.0] with no 0.50.3.0 heading at all. A nonexistent
 * version is handled by never being in this list.
 *
 * 0.49.0.0 is included as a real release that we deliberately did NOT write a
 * playbook for: it is the row that makes the "a version in range with no entry"
 * throw observable, and it is why the throw's error names a real version.
 *
 * Versions strictly after 0.50.5.0 and at or before 0.60.104.0 are the GitHub
 * releases frozen in released-0.60.104.0.json. A file-absent tag also has a
 * noPlaybookRequired spec. A tag whose migration file is in the v0.60.104.0
 * tree is listed here and has no PlaybookSpec yet, so playbooksFor throws.
 */

type FrozenRelease = {
  version: string;
  publishedAt: string;
  migrationFile: boolean;
};

const AFTER_PIN: readonly FrozenRelease[] = frozenReleases.afterPin;

function releaseEvidence(row: FrozenRelease): string {
  const file = `skills/migrations/v${row.version}.md`;
  const presence = row.migrationFile
    ? `${file} is present in the v0.60.104.0 tree`
    : `${file} is absent from the v0.60.104.0 tree`;
  return (
    `GitHub release v${row.version} of garrytan/gbrain, publishedAt ${row.publishedAt}. ${presence}.`
  );
}

export const RELEASED_VERSIONS: readonly ReleasedVersion[] = [
  {
    version: '0.49.0.0',
    evidence:
      'a real upstream release: skills/migrations/v0.49.0.0.md is present in the v0.50.5.0 tree and ' +
      'CHANGELOG.md records [0.49.0.0]. Deliberately absent from PLAYBOOKS — we never ran it, so we ' +
      'can claim nothing about it.',
  },
  {
    version: '0.50.0.0',
    evidence:
      'our pin; CHANGELOG.md records [0.50.0.0] and skills/migrations/0.50.0.0.md is the skill the ' +
      'delta starts from.',
  },
  {
    version: '0.50.1.0',
    evidence:
      'CHANGELOG.md heading [0.50.1.0] at the v0.50.5.0 pin; a 21-PR community fix wave. No ' +
      'skills/migrations/v0.50.1.0.md exists in the v0.50.5.0 tree.',
  },
  {
    version: '0.50.2.0',
    evidence:
      'CHANGELOG.md heading [0.50.2.0] at the v0.50.5.0 pin; write-durability / idempotency fixes. ' +
      'skills/migrations/v0.50.2.0.md is the one new playbook file in this delta.',
  },
  {
    version: '0.50.4.0',
    evidence:
      'CHANGELOG.md heading [0.50.4.0] at the v0.50.5.0 pin, immediately after [0.50.2.0] — 0.50.3.0 ' +
      'was never released. Contributor CI-only changes, no migration file.',
  },
  {
    version: '0.50.5.0',
    evidence:
      'our target; CHANGELOG.md heading [0.50.5.0] at the v0.50.5.0 pin, a security-hardening wave ' +
      '(OAuth scope ceiling, transcript redaction, .env guardrail, bunfig preload lockdown). No ' +
      'skills/migrations/v0.50.5.0.md exists.',
  },
  ...AFTER_PIN.map((row) => ({
    version: row.version,
    evidence: releaseEvidence(row),
  })),
];

/**
 * HOW TO WRITE THE NEXT VERSION'S PLAYBOOK. Follow this exactly; it is the
 * procedure, not a suggestion, and it is here rather than in a runbook because
 * the registry is where someone will be standing when they need it.
 *
 * 1. Read `skills/migrations/v<version>.md` in the TARGET checkout, in full,
 *    once, yourself. Do not summarise it with an LLM and translate the summary:
 *    an LLM may PROPOSE the checklist, it never writes the steps (G5).
 * 2. Record `sha256sum` of that exact file into `upstreamSkill.sha256`. If
 *    upstream amends the file later, the digest mismatch is the signal to
 *    re-read it rather than to trust last year's translation.
 * 3. Take each numbered imperative in turn and put it in exactly ONE bucket:
 *      - it can be written as a function of UpgradeContext that either
 *        succeeds or throws, with no operator judgement -> a PlaybookStep;
 *      - it cannot -> a ChecklistItemSpec whose `why` quotes the sentence that
 *        makes it a judgement call.
 *    Never both. A step you are tempted to write as "try, log, continue" is a
 *    checklist item (honesty rule 6).
 * 4. Steps must be idempotent (a resumed run re-runs them) and must not touch
 *    Docker — only scripts/upgrade.ts does (D1). They execute with the stack
 *    quiesced and gbrain-ops as the only live gbrain process.
 * 5. Anything upstream tells you to do with SQL against gbrain's own tables is
 *    forbidden here (G3). It becomes a checklist item quoting the instruction.
 * 6. If the file exists but prescribes no action, the spec still exists, with
 *    `steps: []` and the quote that says so. Only a version upstream ships NO
 *    file for gets `{ noPlaybookRequired: true, evidence }`.
 * 7. Add the version to RELEASED_VERSIONS with its CHANGELOG evidence, add the
 *    spec to PLAYBOOKS, and extend test/unit/upgrade-playbooks.test.ts's
 *    expected window. The registry invariants in that file are the review gate.
 */
export const PLAYBOOKS: readonly PlaybookSpec[] = [
  {
    version: '0.50.1.0',
    noPlaybookRequired: true,
    evidence:
      'No skills/migrations/v0.50.1.0.md exists in the v0.50.5.0 tree (42 migration skill files at ' +
      'the pin; the 0.50.0.0 -> 0.50.5.0 delta adds exactly one, v0.50.2.0.md).',
  },
  v0_50_2_0,
  {
    version: '0.50.4.0',
    noPlaybookRequired: true,
    evidence:
      'No skills/migrations/v0.50.4.0.md exists in the v0.50.5.0 tree; the release is contributor ' +
      'CI-only per its CHANGELOG entry and no migration file accompanies it.',
  },
  {
    version: '0.50.5.0',
    noPlaybookRequired: true,
    evidence:
      'No skills/migrations/v0.50.5.0.md exists in the v0.50.5.0 tree. The release is a ' +
      'security-hardening wave whose risk is configuration (the .env guardrail quarantine), probed ' +
      'by Task 1 and gated by Task 11, not a migration step.',
  },
  ...AFTER_PIN.filter((row) => !row.migrationFile).map((row): PlaybookSpec => ({
    version: row.version,
    noPlaybookRequired: true,
    evidence: releaseEvidence(row),
  })),
  v0_51_0_0,
  v0_51_7_0,
  v0_51_8_0,
  v0_52_1_0,
  v0_52_2_0,
  v0_53_0_0,
  v0_54_1_0,
  v0_56_2_0,
  v0_58_0_0,
  v0_59_0_0,
  v0_59_2_0,
  v0_59_10_0,
  v0_60_5_0,
  v0_60_6_0,
  v0_60_11_0,
  v0_60_20_0,
  v0_60_26_0,
  v0_60_27_0,
  v0_60_28_0,
  v0_60_30_0,
  v0_60_31_0,
  v0_60_36_0,
  v0_60_37_0,
  v0_60_44_0,
  v0_60_45_0,
  v0_60_47_0,
  v0_60_52_0,
  v0_60_53_0,
  v0_60_57_0,
];

const BY_VERSION = new Map(PLAYBOOKS.map((s) => [s.version, s]));

/**
 * Every spec that applies to the half-open interval (from, to], ascending.
 *
 * THROWS rather than skipping. A version in range with no entry means nobody
 * has read upstream's file for it, and an upgrade that silently skipped it
 * would still produce a green run and an `applied` ledger row — the exact
 * shape honesty rule 7 exists to prevent.
 *
 * `from` itself is NOT required to be in RELEASED_VERSIONS: an install can
 * legitimately sit on a version older than our registry (e.g. 0.48.x), and the
 * half-open window still has to enumerate everything above it. The window is
 * built only from RELEASED_VERSIONS, and any released version in it that has
 * no PLAYBOOKS entry throws — which is what makes the gap check meaningful.
 */
export function playbooksFor(from: string, to: string): PlaybookSpec[] {
  if (cmpVersion(to, from) <= 0) {
    throw new Error(`target ${to} is not ahead of the current version ${from}`);
  }
  const known = new Set(RELEASED_VERSIONS.map((r) => r.version));
  if (!known.has(to)) {
    throw new Error(
      `unknown target version ${to}: add it to RELEASED_VERSIONS with the CHANGELOG evidence ` +
      'that establishes it, then write its playbook entry.',
    );
  }

  const window = RELEASED_VERSIONS
    .map((r) => r.version)
    .filter((v) => cmpVersion(v, from) > 0 && cmpVersion(v, to) <= 0)
    .sort(cmpVersion);

  return window.map((v) => {
    const spec = BY_VERSION.get(v);
    if (!spec) {
      throw new Error(
        `no playbook entry for ${v} in the (${from}, ${to}] window: add a PlaybookSpec, or an ` +
        'explicit { noPlaybookRequired: true, evidence } row naming how you know upstream ships ' +
        'none. A missing entry is not a skip.',
      );
    }
    return spec;
  });
}
