// test/unit/schema-service.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSchemaView, readLockInput } from '../../src/server/schema/service.ts';

let home: string; const packs = join(import.meta.dir, '..', '..', 'packs');
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'mb-home-'));
  for (const [name, file] of [['mobrain-core', 'mobrain-core.json'], ['mobrain-personal', 'mobrain-personal.json'], ['mobrain-brain', 'mobrain-brain.template.json']]) {
    await mkdir(join(home, '.gbrain', 'schema-packs', name!), { recursive: true });
    await cp(join(packs, file!), join(home, '.gbrain', 'schema-packs', name!, 'pack.json'));
  }
});
afterAll(async () => rm(home, { recursive: true, force: true }));

const activeCli = async () => ({ exitCode: 0, stdout: '{"pack":"mobrain-brain","version":"1.0.0"}', stderr: '' });

describe('schema service', () => {
  test('a fresh install passes the lock', async () => {
    const input = await readLockInput({ packsDir: packs, gbrainHome: home, cli: activeCli });
    const { checkCoreLock } = await import('../../src/server/schema/coreLock.ts');
    expect(checkCoreLock(input)).toEqual({ ok: true, problems: [] });
  });

  test('a brain type that shadows core fails the lock', async () => {
    const p = join(home, '.gbrain', 'schema-packs', 'mobrain-brain', 'pack.json');
    const brain = await Bun.file(p).json();
    brain.page_types = [{ name: 'person', primitive: 'entity', path_prefixes: ['p2/'], aliases: [] }];
    await writeFile(p, JSON.stringify(brain));
    const view = await buildSchemaView({ packsDir: packs, gbrainHome: home, cli: activeCli, stats: null, orphans: null });
    expect(view.coreLock.ok).toBe(false);
    brain.page_types = [];
    await writeFile(p, JSON.stringify(brain));
  });

  test('the view labels each type with the layer that defines it', async () => {
    const view = await buildSchemaView({ packsDir: packs, gbrainHome: home, cli: activeCli, stats: { person: 3 }, orphans: [] });
    const person = view.types.find((t) => t.name === 'person')!;
    expect(person.layer).toBe('core');
    expect(person.count).toBe(3);
    expect(view.types.find((t) => t.name === 'journal')!.layer).toBe('personal');
    expect(view.types.find((t) => t.name === 'collector')!.prefixes).toEqual(['system/collectors/']);
    expect(view.active).toBe('mobrain-brain');
  });
});
