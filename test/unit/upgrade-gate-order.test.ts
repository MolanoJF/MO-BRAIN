import { describe, expect, test } from 'bun:test';
import { scoreDoctorGate } from '../../scripts/upgrade.ts';
import type { DoctorBaseline } from '../../src/upgrade/types.ts';

function report(checks: DoctorBaseline['checks']): DoctorBaseline {
  return { capturedAt: '2026-10-08T00:00:00.000Z', status: 'warnings', healthScore: 80, checks };
}

const supervisorOk = { name: 'supervisor', status: 'ok' as const, category: 'ops' };
const supervisorWarn = { name: 'supervisor', status: 'warn' as const, category: 'ops' };
const schemaOk = { name: 'schema_version', status: 'ok' as const };
const embeddingsOk = { name: 'embeddings', status: 'ok' as const };
const embeddingsWarn = { name: 'embeddings', status: 'warn' as const };

describe('scoreDoctorGate', () => {
  test('supervisor ok to warn is not a regression only when the hold is active and the worker is down', () => {
    const before = report([supervisorOk, schemaOk]);
    const after = report([supervisorWarn, schemaOk]);
    const held = scoreDoctorGate(before, after, { holdActive: true, workerDown: true });
    expect(held.regressed).toEqual([]);
    expect(held.schemaVersionOk).toBe(true);

    const workerUp = scoreDoctorGate(before, after, { holdActive: true, workerDown: false });
    expect(workerUp.regressed.map((c) => c.name)).toEqual(['supervisor']);

    const notHeld = scoreDoctorGate(before, after, { holdActive: false, workerDown: true });
    expect(notHeld.regressed.map((c) => c.name)).toEqual(['supervisor']);
  });

  test('any other previously-ok check that is not ok still fails the gate during a hold', () => {
    const parity = scoreDoctorGate(
      report([supervisorOk, embeddingsOk, schemaOk]),
      report([supervisorWarn, embeddingsWarn, schemaOk]),
      { holdActive: true, workerDown: true },
    );
    expect(parity.regressed.map((c) => c.name)).toEqual(['embeddings']);
    expect(parity.schemaVersionOk).toBe(true);
  });
});
