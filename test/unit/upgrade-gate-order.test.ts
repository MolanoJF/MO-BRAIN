import { describe, expect, test } from 'bun:test';
import { compareDoctor } from '../../src/upgrade/digest.ts';
import { resumeBaselineThenGate } from '../../scripts/upgrade.ts';
import type { DoctorBaseline } from '../../src/upgrade/types.ts';

function baseline(checks: DoctorBaseline['checks']): DoctorBaseline {
  return { capturedAt: '2026-10-08T00:00:00.000Z', status: 'warnings', healthScore: 80, checks };
}

describe('resumeBaselineThenGate', () => {
  test('scores doctor while baseline writers are up, then holds', async () => {
    const order: string[] = [];
    const scored = await resumeBaselineThenGate({
      resumeBaseline: async () => { order.push('resume'); },
      captureDoctor: async () => {
        order.push('doctor');
        return baseline([{ name: 'supervisor', status: 'ok', category: 'ops' }, { name: 'schema_version', status: 'ok' }]);
      },
      baseline: baseline([{ name: 'supervisor', status: 'ok', category: 'ops' }, { name: 'schema_version', status: 'ok' }]),
      holdWriters: true,
      stopHeld: async () => { order.push('stop'); },
      recordGate: async () => { order.push('record'); },
    });
    expect(order).toEqual(['resume', 'doctor', 'record', 'stop']);
    expect(scored.held).toBe(true);
    expect(scored.parity.regressed).toEqual([]);
    expect(scored.parity.schemaVersionOk).toBe(true);
  });

  test('a held-down supervisor is not ignored: ok to warn fails and does not stop', async () => {
    const order: string[] = [];
    const before = baseline([{ name: 'supervisor', status: 'ok', category: 'ops' }, { name: 'schema_version', status: 'ok' }]);
    const after = baseline([{ name: 'supervisor', status: 'warn', category: 'ops' }, { name: 'schema_version', status: 'ok' }]);
    const scored = await resumeBaselineThenGate({
      resumeBaseline: async () => { order.push('resume'); },
      captureDoctor: async () => {
        order.push('doctor');
        return after;
      },
      baseline: before,
      holdWriters: true,
      stopHeld: async () => { order.push('stop'); },
      recordGate: async (parity) => {
        order.push('record');
        expect(parity.regressed.map((c) => c.name)).toEqual(['supervisor']);
      },
    });
    expect(compareDoctor(before, after).regressed.map((c) => c.name)).toEqual(['supervisor']);
    expect(order).toEqual(['resume', 'doctor', 'record']);
    expect(scored.held).toBe(false);
    expect(scored.parity.schemaVersionOk).toBe(true);
  });

  test('a passing gate with nothing to hold does not stop writers', async () => {
    const order: string[] = [];
    const scored = await resumeBaselineThenGate({
      resumeBaseline: async () => { order.push('resume'); },
      captureDoctor: async () => {
        order.push('doctor');
        return baseline([{ name: 'schema_version', status: 'ok' }]);
      },
      baseline: baseline([{ name: 'schema_version', status: 'ok' }]),
      holdWriters: false,
      stopHeld: async () => { order.push('stop'); },
      recordGate: async () => { order.push('record'); },
    });
    expect(order).toEqual(['resume', 'doctor', 'record']);
    expect(scored.held).toBe(false);
  });
});
