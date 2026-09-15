import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Parse Dockerfile instruction lines (skip blanks and full-line comments).
 * Continuation lines ending in `\` are joined so a multi-line RUN is one instruction.
 */
function dockerfileInstructions(text: string): string[] {
  const raw = text.split(/\r?\n/);
  const out: string[] = [];
  let buf = '';
  for (const line of raw) {
    const trimmed = line.trimEnd();
    if (!buf && (/^\s*$/.test(trimmed) || /^\s*#/.test(trimmed))) continue;
    if (buf) buf += '\n' + trimmed;
    else buf = trimmed;
    if (trimmed.endsWith('\\')) continue;
    out.push(buf);
    buf = '';
  }
  if (buf) out.push(buf);
  return out;
}

describe('control-plane.Dockerfile ARG scope', () => {
  // Docker ARG declared only before FROM is out of stage scope. The
  // operations.json gate must see a stage-level ARG GBRAIN_VERSION or it
  // expands to contracts/v/operations.json.
  test('redeclares ARG GBRAIN_VERSION in the stage before the operations.json gate', () => {
    const text = readFileSync(join('docker', 'control-plane.Dockerfile'), 'utf8');
    const instructions = dockerfileInstructions(text);

    const fromIdx = instructions.findIndex((i) =>
      /^FROM\b/i.test(i) && /\$\{GBRAIN_VERSION\}/.test(i),
    );
    expect(fromIdx).toBeGreaterThanOrEqual(0);

    const stage = instructions.slice(fromIdx + 1);
    const argIdx = stage.findIndex((i) => /^ARG\s+GBRAIN_VERSION(?:[=\s]|$)/i.test(i));
    const gateIdx = stage.findIndex((i) =>
      /^RUN\b/i.test(i) && /contracts\/v\$\{GBRAIN_VERSION\}\/operations\.json/.test(i),
    );

    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(argIdx).toBeGreaterThanOrEqual(0);
    expect(argIdx).toBeLessThan(gateIdx);
  });
});
