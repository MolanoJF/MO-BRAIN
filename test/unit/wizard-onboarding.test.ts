import { test, expect, describe } from 'bun:test';
import { SOURCE_ID } from '../../src/control/routes/wizard.ts';
import { privateSpaceSourceId } from '../../src/control/privateSpaces.ts';
import { readFileSync } from 'node:fs';

/**
 * Onboarding is Sign in -> OpenAI key -> Create brain. Search mode, schema
 * pack and the first (private) Space are defaults applied by /wizard/prepare;
 * the console asks about none of them.
 */
describe('the onboarding wizard is two calls, not six screens', () => {
  const source = readFileSync(
    new URL('../../src/console/pages/Wizard.tsx', import.meta.url), 'utf8',
  );

  test('it posts the key (verified) and prepare', () => {
    expect(source).toMatch(/\/wizard\/provider/);
    expect(source).toMatch(/verify: true/);
    expect(source).toMatch(/\/wizard\/prepare/);
    expect(source).toMatch(/\/wizard\/finish/);
  });

  test('it no longer drives the granular steps', () => {
    expect(source).not.toMatch(/\/wizard\/search-mode/);
    expect(source).not.toMatch(/\/wizard\/schema/);
    expect(source).not.toMatch(/\/wizard\/private-space/);
  });

  test('it renders no source-id field and no checkbox', () => {
    expect(source).not.toMatch(/<Input[^>]*sourceId/);
    expect(source).not.toMatch(/placeholder="[^"]*source/i);
    expect(source).not.toMatch(/type="checkbox"/);
    expect(source).not.toMatch(/type="text"/);
  });

  test('the generated sourceId satisfies the server\'s own validator', () => {
    expect(SOURCE_ID.test(privateSpaceSourceId('12345678-0000-0000-0000-000000000000'))).toBe(true);
  });
});
