import { test, expect, describe, afterEach, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQL } from 'bun';

/**
 * fileplane.ts binds GBRAIN_HOME / SCHEMA_PACK_DIR at module load (Ruling 14),
 * so the temp home must exist BEFORE the import. test/integration/fileplane.ts
 * can set it in `beforeAll` only because nothing there reads the module-level
 * const before the first test; the schema-pack-json tests below assert on
 * SCHEMA_PACK_DIR itself, so the home is bound here at collection time.
 */
const ORIGINAL_HOME = process.env.GBRAIN_HOME;
const MODULE_HOME = await mkdtemp(join(tmpdir(), 'bs-fileplane-unit-'));
process.env.GBRAIN_HOME = MODULE_HOME;

const {
  mergeConfigJson, takeGrantCredentialsFile, packPath, SCHEMA_PACK_DIR,
  writeSchemaPack, writeSchemaPackJson, readSchemaPackRaw, removeSchemaPack, seedManagedPacks,
} = await import('../../src/ops/fileplane.ts');

afterAll(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = ORIGINAL_HOME;
  await rm(MODULE_HOME, { recursive: true, force: true });
});

/**
 * withAdvisoryLock only needs `sql.reserve()` → a tagged-template connection
 * that resolves to a row array and exposes `release()`. These tests exercise
 * the writer's own logic, not Postgres (that is test/integration/fileplane.ts),
 * so a Postgres-free handle is the right isolation.
 */
const fakeSql = {
  reserve: async () => {
    const conn = (() => Promise.resolve([{ got: true }])) as unknown as { release: () => void };
    conn.release = () => {};
    return conn;
  },
} as unknown as SQL;

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

test('a user pack is written as <name>/pack.yaml, the only shape gbrain discovers', () => {
  // gbrain's defaultPackLocator probes pack.yaml/pack.yml/pack.json INSIDE a
  // directory named after the pack (src/core/schema-pack/load-active.ts).
  // A flat <name>.yaml is never listed and never loadable — MEASURED against
  // the pinned container; see docs/archive/schema-pack-findings.md S1.
  expect(packPath('hr-policies')).toBe(join(SCHEMA_PACK_DIR, 'hr-policies', 'pack.yaml'));
  expect(packPath('hr-policies')).not.toBe(join(SCHEMA_PACK_DIR, 'hr-policies.yaml'));
});

describe('schema pack yaml', () => {
  test('M4: refuses to write the managed pack name', async () => {
    await expect(writeSchemaPack('mobrain-personal', 'name: x\n', { sql: fakeSql })).rejects.toThrow(/managed/);
    await expect(writeSchemaPack('mobrain-core', 'name: x\n', { sql: fakeSql })).rejects.toThrow(/managed/);
  });
});

describe('schema pack json', () => {
  test('writes pack.json and removes a stale pack.yaml sibling', async () => {
    const dir = join(SCHEMA_PACK_DIR, 'legal-ops');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'pack.yaml'), 'stale: true\n');
    await writeSchemaPackJson('legal-ops', { name: 'legal-ops' }, { sql: fakeSql });
    expect(JSON.parse(await readFile(join(dir, 'pack.json'), 'utf8')).name).toBe('legal-ops');
    expect(existsSync(join(dir, 'pack.yaml'))).toBe(false);
  });
  test('refuses a bundled name and a traversing name', async () => {
    await expect(writeSchemaPackJson('gbrain-base-v2', {}, { sql: fakeSql })).rejects.toThrow();
    await expect(writeSchemaPackJson('../x', {}, { sql: fakeSql })).rejects.toThrow();
  });
  test('removeSchemaPack deletes only the named pack directory', async () => {
    await writeSchemaPackJson('zz-gone', { name: 'zz-gone' }, { sql: fakeSql });
    expect((await removeSchemaPack('zz-gone', { sql: fakeSql })).removed).toBe(true);
    expect(existsSync(join(SCHEMA_PACK_DIR, 'zz-gone'))).toBe(false);
    expect((await removeSchemaPack('zz-gone', { sql: fakeSql })).removed).toBe(false);
  });
});

describe('seedManagedPacks', () => {
  const src = async (versions: { core: string; personal: string }) => {
    const dir = await mkdtemp(join(tmpdir(), 'bs-packs-src-'));
    for (const [name, version] of [['mobrain-core', versions.core], ['mobrain-personal', versions.personal]] as const) {
      await writeFile(join(dir, `${name}.json`), JSON.stringify({ name, version, api_version: 'gbrain-schema-pack-v1' }));
    }
    return dir;
  };
  const target = (name = 'mobrain-personal') => join(SCHEMA_PACK_DIR, name, 'pack.json');
  const versionOf = async (name: string) => JSON.parse(await readFile(target(name), 'utf8')).version;
  const clear = () => Promise.all(['mobrain-core', 'mobrain-personal']
    .map((n) => rm(join(SCHEMA_PACK_DIR, n), { recursive: true, force: true })));

  test('seeds core first, then Personal', async () => {
    await clear();
    const r = await seedManagedPacks({ sql: fakeSql, sourceDir: await src({ core: '1.0.0', personal: '2.0.0' }) });
    expect(r).toEqual([
      { name: 'mobrain-core', action: 'written' },
      { name: 'mobrain-personal', action: 'written' },
    ]);
    expect(await versionOf('mobrain-core')).toBe('1.0.0');
    expect(await versionOf('mobrain-personal')).toBe('2.0.0');
  });

  test('leaves the same versions untouched', async () => {
    const r = await seedManagedPacks({ sql: fakeSql, sourceDir: await src({ core: '1.0.0', personal: '2.0.0' }) });
    expect(r.map((x) => x.action)).toEqual(['unchanged', 'unchanged']);
  });

  test('a version bump on one pack rewrites only that one', async () => {
    let r = await seedManagedPacks({ sql: fakeSql, sourceDir: await src({ core: '1.0.0', personal: '2.1.0' }) });
    expect(r.map((x) => x.action)).toEqual(['unchanged', 'written']);
    expect(await versionOf('mobrain-personal')).toBe('2.1.0');
    r = await seedManagedPacks({ sql: fakeSql, sourceDir: await src({ core: '1.1.0', personal: '2.1.0' }) });
    expect(r.map((x) => x.action)).toEqual(['written', 'unchanged']);
    expect(await versionOf('mobrain-core')).toBe('1.1.0');
  });

  test('the API writers refuse both managed names', async () => {
    for (const n of ['mobrain-core', 'mobrain-personal']) {
      await expect(writeSchemaPackJson(n, {}, { sql: fakeSql })).rejects.toThrow(/managed/);
      await expect(writeSchemaPack(n, 'name: x\n', { sql: fakeSql })).rejects.toThrow(/managed/);
      await expect(removeSchemaPack(n, { sql: fakeSql })).rejects.toThrow(/managed/);
    }
  });

  test('the shipped manifests are the default source', async () => {
    await clear();
    await seedManagedPacks({ sql: fakeSql });
    expect(JSON.parse(await readFile(target('mobrain-core'), 'utf8')).name).toBe('mobrain-core');
    expect(JSON.parse(await readFile(target(), 'utf8')).name).toBe('mobrain-personal');
  });
});

describe('readSchemaPackRaw', () => {
  test('returns the stored text and its format, or null', async () => {
    const dir = join(SCHEMA_PACK_DIR, 'raw-read');
    await mkdir(dir, { recursive: true });
    expect(await readSchemaPackRaw('raw-read')).toBeNull();
    await writeFile(join(dir, 'pack.yaml'), 'name: raw-read\n');
    expect(await readSchemaPackRaw('raw-read')).toEqual({ format: 'yaml', text: 'name: raw-read\n' });
    await rm(join(dir, 'pack.yaml'));
    await writeFile(join(dir, 'pack.json'), '{"name":"raw-read"}\n');
    expect(await readSchemaPackRaw('raw-read')).toEqual({ format: 'json', text: '{"name":"raw-read"}\n' });
    await expect(readSchemaPackRaw('mobrain-core')).rejects.toThrow(/managed/);
  });
});
