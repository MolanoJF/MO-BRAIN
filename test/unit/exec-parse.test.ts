import { test, expect, describe } from 'bun:test';
import { extractReceiptJson } from '../../src/contracts/json.ts';

// Failure B of inv-051-b: exec.ts's comment promised the LAST balanced JSON
// value but the code took the FIRST `{`/`[`, so a leading diagnostic line that
// contains a bracket made a valid receipt unparseable with exit 0. These are
// the cases that drive the pure extractor.
describe('extractReceiptJson', () => {
  test('skips a leading diagnostic line that contains braces', () => {
    const stdout = '[gbrain] notice {not-json}\n{"schema_version":1,"pack":"gbrain-base"}\n';
    expect(extractReceiptJson(stdout)).toEqual({ schema_version: 1, pack: 'gbrain-base' });
  });

  test('parses a plain single object', () => {
    expect(extractReceiptJson('{"ok":true}\n')).toEqual({ ok: true });
  });

  test('parses an array receipt', () => {
    expect(extractReceiptJson('[{"id":1},{"id":2}]\n')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test('returns the last of two JSON values', () => {
    expect(extractReceiptJson('{"first":1}\n{"second":2}\n')).toEqual({ second: 2 });
  });

  test('ignores braces inside strings', () => {
    expect(extractReceiptJson('{"note":"}{ not a brace","ok":true}'))
      .toEqual({ note: '}{ not a brace', ok: true });
  });

  test('finds a valid receipt nested inside a balanced non-JSON block', () => {
    // The server's scanner does not skip a balanced-but-non-JSON region; it
    // keeps scanning so a receipt nested inside a prose brace block is found.
    expect(extractReceiptJson('{prose {"ok":true} more}\n')).toEqual({ ok: true });
  });

  test('returns null for empty, whitespace, or garbage', () => {
    expect(extractReceiptJson('')).toBeNull();
    expect(extractReceiptJson('   \n\t')).toBeNull();
    expect(extractReceiptJson('not json at all')).toBeNull();
    expect(extractReceiptJson('{unbalanced')).toBeNull();
  });
});
