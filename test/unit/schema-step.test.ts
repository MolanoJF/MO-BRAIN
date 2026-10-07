import { describe, expect, test } from 'bun:test';
import { schemaStepJournal, schemaStepParams } from '../../src/upgrade/schema-step.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';

describe('schema step at 0.60.104.0', () => {
  test('always skips the Phase F autopilot install', () => {
    expect(schemaStepParams()).toEqual({
      yes: true,
      nonInteractive: true,
      noAutopilotInstall: true,
    });
    const flags = OPERATIONS.applyMigrations!.params.map((p) => p.flag);
    expect(flags).toContain('--no-autopilot-install');
  });

  test('a zero exit does not claim the 0.50 delta had no migrations', () => {
    const event = schemaStepJournal(0);
    expect(event.data).toEqual({ exitCode: 0, outcome: 'exited_0' });
    expect(event.message).not.toMatch(/no migrations were pending/i);
    expect(event.message).not.toMatch(/0\.50\.0\.0/);
    expect(event.message).not.toMatch(/byte-identical/);
  });
});
