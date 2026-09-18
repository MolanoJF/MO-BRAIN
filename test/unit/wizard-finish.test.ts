import { test, expect, describe } from 'bun:test';
import { finishCallOpts } from '../../src/control/routes/wizard.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';

describe('wizard /finish json flags', () => {
  // Would fail if finish still blanket-passed json: true for every step.
  test('init and config.set do not request --json; sync/embed/doctor do', () => {
    expect(finishCallOpts('init')).toEqual({});
    expect(finishCallOpts('config.set')).toEqual({});
    expect(finishCallOpts('sync')).toEqual({ json: true });
    expect(finishCallOpts('embed')).toEqual({ json: true });
    expect(finishCallOpts('doctor')).toEqual({ json: true });
  });

  test('ops-side buildArgv still hard-refuses --json for init and config.set', () => {
    expect(() =>
      buildArgv(OPERATIONS.init!, { nonInteractive: true, embeddingModel: 'openai:text-embedding-3-small' }, { json: true }),
    ).toThrow('init does not support --json');

    expect(() =>
      buildArgv(OPERATIONS['config.set']!, { key: 'search.mode', value: 'conservative' }, { json: true }),
    ).toThrow('config.set does not support --json');
  });
});
