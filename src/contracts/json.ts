/**
 * One scanner for the gbrain receipt convention, shared by both production
 * callers: the ops server's JSON parsing (`src/ops/server.ts`) and
 * `execOperation` (`src/contracts/exec.ts`).
 *
 * gbrain prints prose and progress JSON before its machine-readable receipt,
 * and `sync` prints the embed cost-gate object ahead of its receipt. Parsing
 * from the FIRST `{` makes `json` null for exactly the command the scheduler
 * runs most, and a null receipt is not "nothing changed" — it is unknown.
 * This returns the LAST balanced JSON value, so a leading diagnostic line that
 * carries a bracket cannot hide the receipt (inv-051-b, Failure B).
 */

/** Index of the bracket closing the value that opens at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The LAST complete, balanced top-level JSON object/array that `JSON.parse`s,
 * or null. A balanced value that is not JSON is not skipped wholesale: scanning
 * continues inside it, so a valid receipt nested in a prose brace block is
 * still found.
 */
export function extractReceiptJson(stdout: string): unknown {
  let found: unknown = null;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i]!;
    if (ch !== '{' && ch !== '[') continue;
    const end = balancedEnd(stdout, i);
    if (end < 0) continue;
    try {
      found = JSON.parse(stdout.slice(i, end + 1)) as unknown;
      i = end; // anything inside this value belongs to it, not to a later one
    } catch { /* not JSON: keep scanning for a later value */ }
  }
  return found;
}
