import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeConfigJson, takeGrantCredentialsFile } from '../../src/ops/fileplane.ts';

describe('mergeConfigJson', () => {
  test('creates a document when none exists', () => {
    expect(JSON.parse(mergeConfigJson(null, { openai_api_key: 'sk-x' })))
      .toEqual({ openai_api_key: 'sk-x' });
  });

  // The whole point of S3: a concurrent writer must not lose the other key.
  test('preserves keys it is not patching', () => {
    const current = JSON.stringify({ openai_api_key: 'sk-a', engine: 'postgres' });
    expect(JSON.parse(mergeConfigJson(current, { anthropic_api_key: 'sk-b' })))
      .toEqual({ openai_api_key: 'sk-a', engine: 'postgres', anthropic_api_key: 'sk-b' });
  });

  test('overwrites a key it is patching', () => {
    const current = JSON.stringify({ openai_api_key: 'old' });
    expect(JSON.parse(mergeConfigJson(current, { openai_api_key: 'new' })).openai_api_key)
      .toBe('new');
  });

  test('refuses to clobber a corrupt document', () => {
    expect(() => mergeConfigJson('{not json', { a: 1 }))
      .toThrow('refusing to overwrite unparseable config.json');
  });
});

describe('takeGrantCredentialsFile', () => {
  const origHome = process.env.GBRAIN_HOME;
  let home: string | undefined;

  afterEach(async () => {
    if (origHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = origHome;
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
  });

  async function setupHome(): Promise<string> {
    home = await mkdtemp(join(tmpdir(), 'bs-creds-'));
    process.env.GBRAIN_HOME = home;
    return home;
  }

  test('parses json then deletes the file', async () => {
    const dir = await setupHome();
    const path = join(dir, '.creds-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json');
    const secret = { client_id: 'gbrain_cl_x', client_secret: 'sk-once' };
    await writeFile(path, JSON.stringify(secret));
    expect(await takeGrantCredentialsFile(path)).toEqual(secret);
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test('invalid json is not unlinked', async () => {
    const dir = await setupHome();
    const path = join(dir, '.creds-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json');
    await writeFile(path, '{not json');
    let err: unknown;
    try {
      await takeGrantCredentialsFile(path);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/not json/i);
    expect(await Bun.file(path).exists()).toBe(true);
  });
});
