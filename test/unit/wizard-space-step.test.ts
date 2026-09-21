import { test, expect, describe } from 'bun:test';
import { FIRST_SPACE } from '../../src/console/pages/Wizard.tsx';
import { SOURCE_ID } from '../../src/control/routes/wizard.ts';
import { readFileSync } from 'node:fs';

/**
 * Every org's first Space is just "mine" — there is no naming decision in it
 * worth a form. What IS worth a gate is the isolation notice: folders inside a
 * Space are not access boundaries, and that is informed consent, not naming.
 * So the defaults get filled in and the checkbox stays.
 */
describe('the wizard\'s first Space needs no name (S4b)', () => {
  test('the defaults are exactly what the spec fixes them at', () => {
    expect(FIRST_SPACE.sourceId).toBe('my-brain');
    expect(FIRST_SPACE.name).toBe('My Brain');
  });

  test('the default sourceId satisfies the server\'s own validator', () => {
    // POST /wizard/space answers 400 for anything this regex rejects. A default
    // the server refuses would make the step impossible to complete at all.
    expect(SOURCE_ID.test(FIRST_SPACE.sourceId)).toBe(true);
  });

  const source = readFileSync(
    new URL('../../src/console/pages/Wizard.tsx', import.meta.url), 'utf8',
  );
  const spaceStep = source.slice(source.indexOf('function SpaceStep'));

  test('SpaceStep renders no text inputs', () => {
    // The regression this guards: re-adding a "source id" field, which is the
    // thing a first-run user has no basis to answer.
    expect(spaceStep).not.toMatch(/placeholder=/);
    expect(spaceStep).not.toMatch(/type="text"/);
  });

  test('the isolation checkbox survives, and still gates the button', () => {
    expect(spaceStep).toMatch(/type="checkbox"/);
    expect(spaceStep).toMatch(/disabled=\{busy \|\| !acknowledged\}/);
    // and nothing else gates it — no leftover `|| !sourceId`
    expect(spaceStep).not.toMatch(/!sourceId/);
  });

  test('the button submits the fixed defaults', () => {
    expect(spaceStep).toMatch(/FIRST_SPACE/);
  });
});
