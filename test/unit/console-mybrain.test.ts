import { test, expect } from 'bun:test';
import { toggleRead, myBrainIntro, MY_BRAIN_ADMIN_INTRO } from '../../src/console/pages/MyBrain.tsx';

test('toggling a company Space adds or removes it, keeping order stable', () => {
  expect(toggleRead([], 'a')).toEqual(['a']);
  expect(toggleRead(['a', 'b'], 'a')).toEqual(['b']);
  expect(toggleRead(['b'], 'a')).toEqual(['b', 'a']);
});

test('the intro mentions org-wide Sources only for admins', () => {
  expect(myBrainIntro('owner')).toContain(MY_BRAIN_ADMIN_INTRO);
  expect(myBrainIntro('admin')).toContain(MY_BRAIN_ADMIN_INTRO);
  expect(myBrainIntro('viewer')).not.toContain('Sources');
  expect(myBrainIntro(undefined)).not.toContain(MY_BRAIN_ADMIN_INTRO);
});
