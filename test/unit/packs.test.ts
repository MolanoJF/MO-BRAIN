// test/unit/packs.test.ts
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dir, '..', '..', 'packs');
const read = (n: string) => JSON.parse(readFileSync(join(dir, n), 'utf8'));
type Pack = {
  name: string; version: string; extends: string | null; gbrain_min_version: string;
  page_types: { name: string; path_prefixes: string[] }[];
  link_types: { name: string; inference?: { regex?: string; ner_only?: boolean } }[];
};

describe('shipped packs', () => {
  const core = read('mobrain-core.json') as Pack;
  const personal = read('mobrain-personal.json') as Pack;
  const brain = read('mobrain-brain.template.json') as Pack;

  test('the chain is core <- personal <- brain', () => {
    expect(core.extends).toBeNull();
    expect(personal.extends).toBe('mobrain-core');
    expect(brain.extends).toBe('mobrain-personal');
    expect(brain.page_types).toEqual([]);
  });

  test('core 1.1.0 declares the collector type', () => {
    expect(core.version).toBe('1.1.0');
    const t = core.page_types.find((p) => p.name === 'collector');
    expect(t?.path_prefixes).toEqual(['system/collectors/']);
  });

  test('both shipped packs require gbrain 0.60.230', () => {
    expect(core.gbrain_min_version).toBe('0.60.230');
    expect(personal.gbrain_min_version).toBe('0.60.230');
  });

  test('every regex-inferred personal link type is ner_only', () => {
    for (const name of ['founded', 'works_at', 'advises']) {
      const l = personal.link_types.find((x) => x.name === name);
      expect(l?.inference?.ner_only).toBe(true);
    }
  });

  test('SHA256SUMS matches the shipped files', () => {
    const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
    for (const line of sums) {
      const [hash, file] = line.split(/\s+/);
      const actual = createHash('sha256').update(readFileSync(join(dir, file!))).digest('hex');
      expect(actual).toBe(hash!);
    }
    expect(sums.map((l) => l.split(/\s+/)[1]).sort()).toEqual(['mobrain-core.json', 'mobrain-personal.json']);
  });
});
