import { test, expect } from 'bun:test';
import { toggleRead } from '../../src/console/pages/MyBrain.tsx';

test('toggling a company Space adds or removes it, keeping order stable', () => {
  expect(toggleRead([], 'a')).toEqual(['a']);
  expect(toggleRead(['a', 'b'], 'a')).toEqual(['b']);
  expect(toggleRead(['b'], 'a')).toEqual(['b', 'a']);
});
