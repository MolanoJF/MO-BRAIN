import { test, expect } from 'bun:test';
import { scaffoldEntries } from '../../src/control/scaffold.ts';

const src = {
  pack: 'legal-ops',
  pageTypes: [
    { name: 'contract', primitive: 'entity', pathPrefixes: ['legal/contracts/', 'contracts/'], aliases: ['agreement'], extractable: true },
    { name: 'matter', primitive: 'temporal', pathPrefixes: ['matters/'], aliases: [], extractable: false },
    { name: 'inbox', primitive: 'annotation', pathPrefixes: ['inbox'], aliases: [], extractable: false },
    { name: 'bad', primitive: 'entity', pathPrefixes: ['../etc/'], aliases: [], extractable: false },
  ],
  filingRules: [{ kind: 'contract', directory: 'contracts/', description: 'A signed agreement' }],
  linkTypes: [{ name: 'governs', inverse: 'governed_by', pageType: 'contract', targetType: 'matter' }],
};

test('one folder per type: filing rule first, else first folder-shaped prefix', () => {
  expect(scaffoldEntries(src).map((e) => e.dir)).toEqual(['contracts/', 'matters/']);
});

test('the README names the type, primitive, description, prefixes and verbs', () => {
  const readme = scaffoldEntries(src)[0]!.readme;
  expect(readme).toContain('# Contract');
  expect(readme).toContain('`contract`');
  expect(readme).toContain('entity');
  expect(readme).toContain('A signed agreement');
  expect(readme).toContain('legal/contracts/');
  expect(readme).toContain('governs');
  expect(readme).toContain('legal-ops');
});

test('never emits a traversing, absolute or non-directory path', () => {
  for (const e of scaffoldEntries(src)) expect(e.dir).toMatch(/^([a-z0-9][a-z0-9_-]*\/)+$/);
});
