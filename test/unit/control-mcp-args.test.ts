import { describe, expect, test } from 'bun:test';
import { validateArgs, type InputSchema } from '../../src/control/mcp/args.ts';

const S: InputSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 5 },
    count: { type: 'integer' },
    ratio: { type: ['number', 'string'] },
    mode: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
    draft: { type: 'object' },
    on: { type: 'boolean' },
  },
  required: ['name'],
  additionalProperties: false,
};

describe('validateArgs', () => {
  test('accepts a valid object and returns it', () => {
    const r = validateArgs(S, { name: 'x', count: 2, ratio: '1.5', mode: 'a', tags: ['t'], draft: {}, on: true });
    expect(r.ok).toBe(true);
  });

  test('missing arguments default to {} and still enforce required', () => {
    expect(validateArgs({ ...S, required: [] }, undefined)).toEqual({ ok: true, args: {} });
    expect(validateArgs(S, undefined)).toEqual({ ok: false, errors: ['missing argument: name'] });
  });

  test('Review focus 4: non-objects are refused', () => {
    for (const bad of [[], 'x', 1, true]) {
      expect(validateArgs(S, bad)).toEqual({ ok: false, errors: ['arguments must be an object'] });
    }
  });

  test('Review focus 4: unknown keys are refused, including identity and prototype keys', () => {
    const r = validateArgs(S, JSON.parse('{"name":"x","userId":"u","__proto__":{"a":1}}'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('unknown argument: userId');
      expect(r.errors).toContain('unknown argument: __proto__');
    }
  });

  test('type, enum, maxLength and item checks', () => {
    const r = validateArgs(S, { name: 'toolong', count: 1.5, mode: 'z', tags: [1], on: 'yes', draft: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual(expect.arrayContaining([
        'name is longer than 5', 'count must be integer', 'mode must be one of a, b',
        'tags[0] must be string', 'on must be boolean', 'draft must be object',
      ]));
    }
  });

  test('NaN and Infinity are not numbers', () => {
    expect(validateArgs(S, { name: 'x', ratio: Number.NaN }).ok).toBe(false);
  });
});
