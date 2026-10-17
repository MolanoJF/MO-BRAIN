import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';

let w: TestWorld; let key: string; let tmp: string;
beforeAll(async () => {
  w = await world();
  tmp = await mkdtemp(join(tmpdir(), 'mb-inst-'));
  await mkdir(join(tmp, 'gskills', 'ingest'), { recursive: true });
  await writeFile(join(tmp, 'gskills', 'RESOLVER.md'), '# RESOLVER\n');
  await writeFile(join(tmp, 'gskills', 'ingest', 'SKILL.md'), 'ingest');
  await mkdir(join(tmp, 'app', 'skills', 'mobrain-collect'), { recursive: true });
  await mkdir(join(tmp, 'app', 'bin'), { recursive: true });
  await writeFile(join(tmp, 'app', 'skills', 'RESOLVER.mobrain.md'), '| mobrain-collect | x |');
  await writeFile(join(tmp, 'app', 'skills', 'mobrain-collect', 'SKILL.md'), 'collect');
  await writeFile(join(tmp, 'app', 'bin', 'mobrain'), '#!/usr/bin/env bash\n');
  w.deps.env.gbrainSkillsDir = join(tmp, 'gskills'); w.deps.env.appDir = join(tmp, 'app');
  ({ apiKey: key } = await new PeopleService(w.deps).bootstrapOwner({ email: 'own@x.io' }));
});
afterAll(async () => { await w.drop(); await rm(tmp, { recursive: true, force: true }); });

test('the CLI downloads without a key', async () => {
  expect(await (await w.req('/install/mobrain')).text()).toStartWith('#!/usr/bin/env bash');
});

test('the skills bundle needs a key and holds both skill sets and one merged resolver', async () => {
  expect((await w.req('/install/skills.tar.gz')).status).toBe(401);
  const r = await w.req('/install/skills.tar.gz', { as: key });
  const out = join(tmp, 'x'); await mkdir(out);
  await Bun.write(join(tmp, 's.tgz'), await r.arrayBuffer());
  await Bun.spawn(['tar', '-xzf', join(tmp, 's.tgz'), '-C', out]).exited;
  expect(await Bun.file(join(out, 'ingest', 'SKILL.md')).text()).toBe('ingest');
  expect(await Bun.file(join(out, 'mobrain-collect', 'SKILL.md')).text()).toBe('collect');
  expect(await Bun.file(join(out, 'RESOLVER.md')).text()).toContain('<!-- mobrain:begin -->\n| mobrain-collect | x |');
  expect(await Bun.file(join(out, 'RESOLVER.mobrain.md')).exists()).toBe(false);
});
