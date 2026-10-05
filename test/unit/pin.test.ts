import { test, expect, describe } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GBRAIN_PIN, contractsDir, operationsPath, capabilityPath, verifyRuntimePin,
  pinAtLeast, pageDeleteNeedsForce, type CallOps,
} from '../../src/contracts/pin.ts';
import { toolNames, type CapabilitySnapshot } from '../../src/contracts/capability.ts';

const EXPECTED = process.env.GBRAIN_VERSION ?? '0.50.0.0';

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) yield p;
  }
}

describe('pin.ts', () => {
  test('GBRAIN_PIN reflects the declared version', () => {
    expect(GBRAIN_PIN).toBe(EXPECTED);
  });

  test('contractsDir/operationsPath/capabilityPath default to the declared pin', () => {
    expect(contractsDir()).toBe(`contracts/v${EXPECTED}`);
    expect(operationsPath()).toBe(`contracts/v${EXPECTED}/operations.json`);
    expect(capabilityPath()).toBe(`contracts/v${EXPECTED}/capability.json`);
  });

  test('every path helper accepts an explicit version, for probing a candidate pin', () => {
    expect(contractsDir('0.50.5.0')).toBe('contracts/v0.50.5.0');
    expect(operationsPath('0.50.5.0')).toBe('contracts/v0.50.5.0/operations.json');
    expect(capabilityPath('0.50.5.0')).toBe('contracts/v0.50.5.0/capability.json');
  });

  test('verifyRuntimePin never claims a match it cannot prove', async () => {
    // Plan sample passed a bare lambda returning `json: { checks: [] }`,
    // which is not assignable to the generic `CallOps` result (`json: T |
    // null` for arbitrary T) — it cannot compile. An explicit `CallOps`-typed
    // stub with `json: null` is the minimal type-correct equivalent, and it
    // carries the same meaning: a successful doctor call with no version field.
    const fakeOps: CallOps = async () => ({ ok: true, exitCode: 0, json: null });
    const result = await verifyRuntimePin(fakeOps);
    expect(result.declared).toBe(GBRAIN_PIN);
    expect(result.observed).toBeNull();
    expect(result.matches).toBeNull(); // not false — unverifiable is not a mismatch
  });

  test('verifyRuntimePin survives an unreachable ops server without throwing', async () => {
    const result = await verifyRuntimePin(async () => { throw new Error('ECONNREFUSED'); });
    expect(result.declared).toBe(GBRAIN_PIN);
    expect(result.matches).toBeNull();
  });

  // The pin compare that gates the 0.51-only `page.delete --force`: numeric per
  // dot-separated part, missing parts read as 0. `'0.51.0.0' >= '0.51'` and
  // `'1.0' >= '0.99.9.9'` are the cases a string compare gets wrong.
  test('pinAtLeast compares dot-separated parts numerically, missing parts as 0', () => {
    expect(pinAtLeast('0.51.0.0', '0.51')).toBe(true);
    expect(pinAtLeast('0.50.5.0', '0.51.0.0')).toBe(false);
    expect(pinAtLeast('0.51.0.1', '0.51.0.0')).toBe(true);
    expect(pinAtLeast('1.0', '0.99.9.9')).toBe(true);
  });

  test('pageDeleteNeedsForce is true only where the revision-checked delete exists', () => {
    expect(pageDeleteNeedsForce('0.50.5.0')).toBe(false);
    expect(pageDeleteNeedsForce('0.51.0.0')).toBe(true);
  });

  test('pinned-next capability snapshot is a real 0.51.0.0 capture', async () => {
    const snap = JSON.parse(await readFile('contracts/v0.51.0.0/capability.json', 'utf8')) as CapabilitySnapshot;
    expect(snap.gbrainVersion).toBe('0.51.0.0');
    expect(snap.wellKnown).not.toBeNull();
    expect(toolNames(snap.tools).length).toBeGreaterThan(0);
    expect(capabilityPath('0.51.0.0')).toBe('contracts/v0.51.0.0/capability.json');
  });

  // This is what stops the connections.ts bug class (a hardcoded
  // 'contracts/v0.50.0.0/...' path) from returning under a different name.
  test('no file under src/ or scripts/ hardcodes the literal v0.50.0.0 path outside pin.ts', async () => {
    const offenders: string[] = [];
    for (const root of ['src', 'scripts']) {
      for await (const file of walk(root)) {
        if (file === join('src', 'contracts', 'pin.ts')) continue;
        const lines = (await readFile(file, 'utf8')).split('\n');
        lines.forEach((line, i) => {
          const trimmed = line.trim();
          const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/**');
          if (!isComment && line.includes('v0.50.0.0')) offenders.push(`${file}:${i + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
