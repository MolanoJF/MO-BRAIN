import { test, expect, describe } from 'bun:test';
import { finishCallOpts, canResumeFinish, FINISH_EMBED_MAX_USD } from '../../src/control/routes/wizard.ts';
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

test('finish passes the stored schema pack to init', () => {
  // The pack has to reach `init`, not a later `config set`: init writes
  // config.json's schema_pack itself (defaulting to gbrain-base-v2) and would
  // stamp over anything written first, and the pack must already be active
  // when `sync` runs for imported pages to be typed by it.
  const argv = buildArgv(OPERATIONS.init!, {
    nonInteractive: true,
    force: true,
    embeddingModel: 'openai:text-embedding-3-small',
    schemaPack: 'gbrain-recommended',
  });
  expect(argv).toContain('--schema-pack');
  expect(argv[argv.indexOf('--schema-pack') + 1]).toBe('gbrain-recommended');
});

test('finish omits --schema-pack entirely when no pack was chosen', () => {
  // An absent value must not become an empty string: `gbrain init
  // --schema-pack ""` would set a pack name of "" rather than fall back to
  // init's own default.
  const argv = buildArgv(OPERATIONS.init!, {
    nonInteractive: true, force: true, embeddingModel: 'openai:text-embedding-3-small',
  });
  expect(argv).not.toContain('--schema-pack');
});

describe('finish sync and embed argv', () => {
  test('sync skips the git pull and the paid embed', () => {
    const argv = buildArgv(OPERATIONS.sync!, { all: true, noPull: true, noEmbed: true }, { json: true });
    expect(argv).toContain('--no-pull');
    expect(argv).toContain('--no-embed');
  });

  test('embed carries a spend cap so a headless run is not stopped for consent', () => {
    const argv = buildArgv(OPERATIONS.embed!, { stale: true, maxUsd: FINISH_EMBED_MAX_USD }, { json: true });
    expect(argv[argv.indexOf('--max-usd') + 1]).toBe(FINISH_EMBED_MAX_USD);
    expect(Number(FINISH_EMBED_MAX_USD)).toBeGreaterThan(0);
  });
});

describe('canResumeFinish', () => {
  test('a brain with no Spaces never resumes', async () => {
    expect(await canResumeFinish([], 'mobrain-personal')).toBe(false);
  });
});
