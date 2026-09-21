import { test, expect } from 'bun:test';
import { parseSchemaActiveProse } from '../../src/contracts/capability.ts';

// Verbatim stdout from `gbrain schema active` on the pinned 0.50.5.0
// container. `--json` is accepted and IGNORED (byte-identical output), so
// this prose is the only machine-readable surface there is.
const REAL = `Active pack: gbrain-base-v2 v1.2.0
Source: home-config
Pack identity: gbrain-base-v2@1.2.0+1a2aee67
Page types: 19
Link verbs: 17
Takes kinds: fact, take, bet, hunch

14-type DRY/MECE canonical taxonomy + \`note\` catch-all (15 total).
`;

test('parses the real schema active prose', () => {
  const a = parseSchemaActiveProse(REAL);
  expect(a.pack).toBe('gbrain-base-v2');
  expect(a.version).toBe('1.2.0');
  expect(a.source).toBe('home-config');
  expect(a.identity).toBe('gbrain-base-v2@1.2.0+1a2aee67');
  expect(a.pageTypes).toBe(19);
  expect(a.linkVerbs).toBe(17);
});

test('parses a db-config tier, which is the one that shadows our write', () => {
  const a = parseSchemaActiveProse('Active pack: dirpack v1.0.0\nSource: db-config\n');
  expect(a.pack).toBe('dirpack');
  expect(a.source).toBe('db-config');
});

test('a user pack name with hyphens and digits survives', () => {
  const a = parseSchemaActiveProse('Active pack: hr-policies-2 v0.3.1\nSource: home-config\n');
  expect(a.pack).toBe('hr-policies-2');
  expect(a.version).toBe('0.3.1');
});

test('unparseable output yields nulls and keeps the raw text, never throws', () => {
  const a = parseSchemaActiveProse('Error: no brain configured\n');
  expect(a.pack).toBeNull();
  expect(a.source).toBeNull();
  expect(a.raw).toContain('no brain configured');
});
