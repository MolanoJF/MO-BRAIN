/**
 * The single source of the declared harness pin, and the runtime cross-check
 * that reads the version back out of the installed binary.
 *
 * Mirrors `src/contracts/pin.ts`'s GBRAIN_PIN / verifyRuntimePin for the second
 * pinned dependency this slice adds (G1, D4). Kills the same class of bug:
 * a reader independently computing `process.env.HARNESS_VERSION ?? '2.1.274'`
 * and drifting from whatever this file says.
 *
 * D4's honesty rule: the pin in a compose file is not evidence the binary
 * moved. Only `claude --version` is, and that is what this module runs.
 */
import type { PinVerification } from '../contracts/pin.ts';

export const HARNESS_PIN = process.env.HARNESS_VERSION ?? '2.1.274';

/**
 * Same shape, and the same null-is-not-false convention, as the gbrain pin's
 * `PinVerification`: `observed: null` means "unverifiable", never "mismatched".
 */
export type HarnessPinVerification = PinVerification;

/**
 * The seam a fake occupies in tests; production spawns the real binary through
 * `readHarnessVersion` below. Structural rather than a spawn helper, so this
 * module stays a leaf with no import cycle back through the runner.
 */
export type ReadHarnessVersion = () => Promise<string>;

/**
 * `claude --version` prints `2.1.274 (Claude Code)` -- the version is the FIRST
 * whitespace-separated token. A first token that is not a semver is a broken
 * install (a "Script not found" line, a shell error), not a version we failed
 * to like: unverifiable, so this returns null rather than a bogus string that
 * would render as a mismatch.
 */
function parseHarnessVersion(stdout: string): string | null {
  const first = stdout.trim().split(/\s+/)[0] ?? '';
  return /^\d+\.\d+\.\d+/.test(first) ? first : null;
}

async function readHarnessVersion(): Promise<string> {
  // argv array, never a shell string (G2) -- the same rule `claude` now shares
  // with `gbrain`.
  const proc = Bun.spawn(['claude', '--version'], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`claude --version exited ${exitCode}`);
  return stdout;
}

/**
 * Honesty rule from D4: the runner refuses a claim whose `harnessVersion` does
 * not equal the version the installed binary actually reports.
 *
 * `expected` defaults to this image's own pin (a startup self-check). The claim
 * path passes `claim.harnessVersion`, which is the reference that matters at
 * runtime: it is what the control plane believed it was dispatching to.
 *
 * A caller must refuse the run unless `matches === true`. `matches === null`
 * (no harness, or a version line we cannot parse) is a failure to verify, which
 * is a different failure class from a mismatch and must be reported as one.
 */
export async function verifyHarnessPin(
  expected: string = HARNESS_PIN,
  read: ReadHarnessVersion = readHarnessVersion,
): Promise<HarnessPinVerification> {
  let observed: string | null = null;
  try {
    observed = parseHarnessVersion(await read());
  } catch {
    // Unreachable is also "unverifiable", not "mismatched".
  }
  return { declared: expected, observed, matches: observed === null ? null : observed === expected };
}
