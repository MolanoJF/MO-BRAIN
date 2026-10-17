import { expect, test } from 'bun:test';
import { mergeResolver } from '../../src/server/install.ts';

const block = '| mobrain-collect | run a collector |';

test('appends a marked Mo-brain block to gbrain\'s resolver', () => {
  const out = mergeResolver('# RESOLVER\n| ingest | x |\n', block);
  expect(out).toBe('# RESOLVER\n| ingest | x |\n\n<!-- mobrain:begin -->\n| mobrain-collect | run a collector |\n<!-- mobrain:end -->\n');
});

test('replaces an existing block instead of adding a second one', () => {
  const once = mergeResolver('# R\n', 'old');
  expect(mergeResolver(once, block).match(/mobrain:begin/g)!.length).toBe(1);
  expect(mergeResolver(once, block)).toContain(block);
  expect(mergeResolver(once, block)).not.toContain('old');
});
