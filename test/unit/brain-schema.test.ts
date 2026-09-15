import { test, expect, describe } from 'bun:test';
import {
  resetBrainSchema,
  RESET_BRAIN_SCHEMA_SQL,
  type BrainSql,
} from '../../src/ops/brainSchema.ts';

describe('resetBrainSchema', () => {
  test('RESET_BRAIN_SCHEMA_SQL starts with DROP SCHEMA … CASCADE', () => {
    expect(RESET_BRAIN_SCHEMA_SQL[0]).toMatch(/DROP\s+SCHEMA/i);
    expect(RESET_BRAIN_SCHEMA_SQL[0]).toMatch(/CASCADE/i);
  });

  test('issues DROP SCHEMA CASCADE then recreates public + extensions', async () => {
    const prev = process.env.GBRAIN_DATABASE_URL;
    process.env.GBRAIN_DATABASE_URL = 'postgres://gbrain:unused@127.0.0.1:1/brain';
    const queries: string[] = [];
    let ended = false;
    const fake: BrainSql = {
      unsafe: async (q) => { queries.push(q); },
      end: async () => { ended = true; },
    };
    try {
      await resetBrainSchema({ connect: () => fake });
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_DATABASE_URL;
      else process.env.GBRAIN_DATABASE_URL = prev;
    }

    expect(queries[0]).toMatch(/DROP\s+SCHEMA/i);
    expect(queries[0]).toMatch(/CASCADE/i);
    expect(queries).toEqual([...RESET_BRAIN_SCHEMA_SQL]);
    expect(ended).toBe(true);
  });

  test('refuses to run without GBRAIN_DATABASE_URL', async () => {
    const prev = process.env.GBRAIN_DATABASE_URL;
    delete process.env.GBRAIN_DATABASE_URL;
    try {
      await expect(resetBrainSchema({
        connect: () => { throw new Error('must not connect'); },
      })).rejects.toThrow(/GBRAIN_DATABASE_URL/);
    } finally {
      if (prev !== undefined) process.env.GBRAIN_DATABASE_URL = prev;
    }
  });
});
