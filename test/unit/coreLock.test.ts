// test/unit/coreLock.test.ts
import { describe, expect, test } from 'bun:test';
import { checkCoreLock, type PackFile } from '../../src/server/schema/coreLock.ts';

const core: PackFile = {
  name: 'mobrain-core', version: '1.1.0', extends: null,
  page_types: [{ name: 'person', primitive: 'entity', path_prefixes: ['people/'], aliases: ['human'] }],
  link_types: [{ name: 'mentions' }],
};
const personal: PackFile = {
  name: 'mobrain-personal', version: '2.0.0', extends: 'mobrain-core',
  page_types: [{ name: 'journal', primitive: 'temporal', path_prefixes: ['journal/'], aliases: [] }],
  link_types: [{ name: 'works_at' }],
};
const brain = (over: Partial<PackFile> = {}): PackFile => ({
  name: 'mobrain-brain', version: '1.0.0', extends: 'mobrain-personal', page_types: [], link_types: [], ...over,
});
const hashes = { 'mobrain-core.json': 'aa', 'mobrain-personal.json': 'bb' };
const base = { active: 'mobrain-brain', core, personal, brain: brain(), installedHashes: hashes, expectedHashes: hashes };

describe('checkCoreLock', () => {
  test('passes an intact chain with a new type', () => {
    const r = checkCoreLock({ ...base, brain: brain({ page_types: [{ name: 'deal', primitive: 'entity', path_prefixes: ['deals/'], aliases: [] }] }) });
    expect(r).toEqual({ ok: true, problems: [] });
  });

  test('flags a modified shipped pack', () => {
    const r = checkCoreLock({ ...base, installedHashes: { ...hashes, 'mobrain-core.json': 'zz' } });
    expect(r.problems).toContain('pack_modified:mobrain-core.json');
  });

  test('flags a type, alias, prefix or link type that shadows core or personal', () => {
    const r = checkCoreLock({ ...base, brain: brain({
      page_types: [
        { name: 'person', primitive: 'entity', path_prefixes: ['x/'], aliases: [] },
        { name: 'diary', primitive: 'temporal', path_prefixes: ['journal/'], aliases: ['human'] },
      ],
      link_types: [{ name: 'works_at' }],
    }) });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining([
      'shadowed_type:person', 'shadowed_prefix:journal/', 'shadowed_alias:human', 'shadowed_link_type:works_at',
    ]));
  });

  test('flags the wrong active pack and a broken chain', () => {
    expect(checkCoreLock({ ...base, active: 'gbrain-base' }).problems).toContain('active_pack:gbrain-base');
    expect(checkCoreLock({ ...base, brain: brain({ extends: 'mobrain-core' }) }).problems).toContain('chain:mobrain-brain->mobrain-core');
    expect(checkCoreLock({ ...base, personal: { ...personal, extends: null } }).problems).toContain('chain:mobrain-personal->none');
  });

  test('a missing installed pack is reported, not thrown', () => {
    expect(checkCoreLock({ ...base, brain: null }).problems).toContain('missing_pack:mobrain-brain');
  });
});
