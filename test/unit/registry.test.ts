import { test, expect, describe } from 'bun:test';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { readdirSync, readFileSync } from 'node:fs';

describe('registry invariants', () => {
  test('every operation id matches its key', () => {
    for (const [key, spec] of Object.entries(OPERATIONS)) expect(spec.id).toBe(key);
  });

  test('every operation has a non-empty argv prefix', () => {
    for (const spec of Object.values(OPERATIONS)) expect(spec.argv.length).toBeGreaterThan(0);
  });

  test('every operation declares at least one acceptable exit code', () => {
    for (const spec of Object.values(OPERATIONS)) expect(spec.okExitCodes.length).toBeGreaterThan(0);
  });

  test('param names are unique within an operation', () => {
    for (const spec of Object.values(OPERATIONS)) {
      const names = spec.params.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test('flags are unique within an operation, ignoring positionals', () => {
    for (const spec of Object.values(OPERATIONS)) {
      const flags = spec.params.map((p) => p.flag).filter((f) => f !== '');
      expect(new Set(flags).size).toBe(flags.length);
    }
  });

  test('every operation builds argv with only its required params', () => {
    for (const spec of Object.values(OPERATIONS)) {
      const values = Object.fromEntries(
        spec.params.filter((p) => p.required).map((p) => [p.name, p.kind === 'flag' ? true : 'x']),
      );
      expect(() => buildArgv(spec, values)).not.toThrow();
    }
  });

  // G4: adding an operation without a contract test is not allowed.
  test('every operation family is covered by a contract test file', () => {
    const files = readdirSync('test/contract').join('\n');
    const bodies = readdirSync('test/contract')
      .map((f) => readFileSync(`test/contract/${f}`, 'utf8')).join('\n');
    const uncovered = Object.keys(OPERATIONS).filter(
      (id) => !bodies.includes(`'${id}'`) && !bodies.includes(`OPERATIONS.${id}`),
    );
    expect({ uncovered, files: files.length > 0 }).toEqual({ uncovered: [], files: true });
  });

  // S2: a brain-db operation must never be runnable from the control plane.
  test('privilege is declared on every operation', () => {
    for (const spec of Object.values(OPERATIONS)) {
      expect(['brain-db', 'read-only']).toContain(spec.privilege);
    }
  });
});
