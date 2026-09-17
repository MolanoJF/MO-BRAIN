/**
 * The single source of the declared gbrain pin, and every contracts path
 * derived from it. Kills the class of bug where a reader independently
 * computes `process.env.GBRAIN_VERSION ?? '0.50.0.0'` and drifts from
 * whatever this file says (D8) — `src/control/routes/connections.ts` was
 * the confirmed instance; `src/ops/dispatch.ts`, `scripts/backup.ts` and
 * `scripts/emit-operations.ts` still compute their own fallback and are out
 * of this task's scope, but Step 4's compose fix means they now see the
 * real value at runtime instead of silently defaulting — filed in
 * docs/slice-3.5-findings.md as a residual cleanup, not silently expanded
 * into this task.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';

export const GBRAIN_PIN = process.env.GBRAIN_VERSION ?? '0.50.0.0';

export function contractsDir(version: string = GBRAIN_PIN): string {
  return `contracts/v${version}`;
}

export function operationsPath(version: string = GBRAIN_PIN): string {
  return `${contractsDir(version)}/operations.json`;
}

export function capabilityPath(version: string = GBRAIN_PIN): string {
  return `${contractsDir(version)}/capability.json`;
}

export type PinVerification = {
  declared: string;
  /** null when no reachable operation carries the running binary's version. */
  observed: string | null;
  /** null (not false) when unverifiable — absence of proof is not proof of a mismatch. */
  matches: boolean | null;
};

/** Structural, not imported from opsClient.ts — contracts/ stays below control/ in the layering. */
export type CallOps = <T = unknown>(
  op: string,
  params?: Record<string, unknown>,
  opts?: { json?: boolean; dryRun?: boolean; timeoutMs?: number },
) => Promise<{ ok: boolean; exitCode: number; json: T | null }>;

/**
 * Honesty rule 9: the pin in .env is not evidence the binary moved. This is
 * the first runtime cross-check — today nothing does this.
 *
 * `doctor` (`src/contracts/registry.ts` 'doctor') is the only operation
 * reachable through `callOps` that is version-adjacent at all: no operation
 * returns the running binary's version as a structured field anywhere in
 * today's registry. `doctor`'s own `engine` field is the DB engine
 * ('postgres'|'pglite'), not a gbrain semver. Its one check that ever prints
 * the binary version, `self_upgrade_health`, is pinned to the fixed,
 * version-free message "Self-upgrade disabled (mode=off). Enable: gbrain
 * config set self_upgrade.mode notify" whenever GBRAIN_SELF_UPGRADE_MODE=off
 * — which every gbrain container in this stack sets structurally, gbrain-ops
 * included ('every gbrain container disables self-upgrade',
 * compose-invariants.test.ts). So doctor, reached through gbrain-ops,
 * CANNOT carry the version in this deployment — not "might not", cannot.
 * Scraping that message for a substring guaranteed absent would be worse
 * than reporting the gap (G3): it would look like a working check.
 *
 * Task 7's `checkUpdate` operation now exposes `current_version` as a clean
 * JSON field (upstream's check-update.ts current_source 'package-json'), so
 * this function reads THAT and reports a real `observed` / `matches`. It still
 * never fabricates a match: an unreachable ops relay, or a body whose `.error`
 * is set (U1 — check-update never sets an exit code), leaves `observed` null
 * and `matches` null, which means "unverifiable", not "mismatched".
 */
export async function verifyRuntimePin(callOps: CallOps): Promise<PinVerification> {
  const declared = GBRAIN_PIN;
  let observed: string | null = null;
  try {
    const r = await callOps<{ current_version?: string; error?: string }>(
      'checkUpdate', {}, { json: true, timeoutMs: 30_000 },
    );
    const body = r.json;
    if (body && !body.error && typeof body.current_version === 'string' && body.current_version !== '') {
      observed = body.current_version;
    }
  } catch {
    // Unreachable is also "unverifiable", not "mismatched".
  }
  return { declared, observed, matches: observed === null ? null : observed === declared };
}

/**
 * Atomic pin rewrite: writes a temp file and renames it over `.env`, so a
 * crash mid-write can never leave a half-written pin. Returns the value it
 * replaced.
 *
 * Lives here rather than in `scripts/upgrade.ts` because `rollback()`
 * (`src/upgrade/digest.ts`) must move the pin back, and a `src/` module that
 * dynamically imports the host CLI back is a circular module graph: Bun
 * re-enters the entry module's evaluation and spins a core forever (BUG 1 of
 * Task 17, reproduced). A static import from the pin module — which both the
 * CLI and the rollback already depend on — has no cycle.
 */
export async function writePin(envPath: string, version: string): Promise<string> {
  const raw = await readFile(envPath, 'utf8');
  const match = /^GBRAIN_VERSION=(.*)$/m.exec(raw);
  if (!match) throw new Error(`${envPath} has no GBRAIN_VERSION line to move`);
  const next = raw.replace(/^GBRAIN_VERSION=.*$/m, `GBRAIN_VERSION=${version}`);
  const tmp = `${envPath}.upgrade-tmp`;
  await writeFile(tmp, next, { mode: 0o600 });
  await rename(tmp, envPath);
  return match[1]!.trim();
}
