import { test, expect, describe } from 'bun:test';
import { SOURCE_ID } from '../../src/control/routes/wizard.ts';
import { privateSpaceSourceId } from '../../src/control/privateSpaces.ts';
import { readFileSync } from 'node:fs';

/**
 * A fresh install's wizard creates exactly ONE source: the signed-in admin's
 * own private space. There is no naming decision in it worth a form, and no
 * shared-space isolation consent to collect here — shared Spaces are added
 * later from the Sources page, where that notice belongs.
 */
describe('the wizard\'s first Space is the member\'s own private space', () => {
  const source = readFileSync(
    new URL('../../src/console/pages/Wizard.tsx', import.meta.url), 'utf8',
  );
  const spaceStep = source.slice(source.indexOf('function SpaceStep'));

  test('the step posts to the private-space route, not the shared one', () => {
    expect(source).toMatch(/\/wizard\/private-space/);
    expect(source).not.toMatch(/FIRST_SPACE/);
  });

  test('SpaceStep renders no text inputs', () => {
    // The regression this guards: re-adding a "source id" field, which is the
    // thing a first-run user has no basis to answer.
    expect(spaceStep).not.toMatch(/placeholder=/);
    expect(spaceStep).not.toMatch(/type="text"/);
  });

  test('SpaceStep has no source-id field and no isolation checkbox', () => {
    expect(spaceStep).not.toMatch(/sourceId/);
    expect(spaceStep).not.toMatch(/type="checkbox"/);
  });

  test('the copy frames it as a private space', () => {
    expect(spaceStep).toMatch(/private/i);
  });

  test('the generated sourceId satisfies the server\'s own validator', () => {
    // POST /wizard/private-space derives `my-space-<memberId8>` and
    // addSpaceSource rejects anything this regex refuses.
    expect(SOURCE_ID.test(privateSpaceSourceId('12345678-0000-0000-0000-000000000000'))).toBe(true);
  });
});
