import { test, expect, describe } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pauseBrainWriters, resumeBrainWriters, pauseFilePath } from '../../src/ops/writerGate.ts';

describe('writerGate', () => {
  test('pause writes the pause file and waits before returning', async () => {
    const dir = join(tmpdir(), `writer-gate-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const prev = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = dir;
    const order: string[] = [];
    try {
      await pauseBrainWriters({
        writePause: async () => { order.push('write'); },
        waitUntilQuiet: async () => { order.push('wait'); },
      });
      expect(order).toEqual(['write', 'wait']);
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('default pause creates the file and default resume removes it', async () => {
    const dir = join(tmpdir(), `writer-gate-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const prev = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = dir;
    try {
      await pauseBrainWriters({ waitUntilQuiet: async () => {} });
      const body = await readFile(pauseFilePath(), 'utf8');
      expect(body.length).toBeGreaterThan(0);
      await resumeBrainWriters();
      await expect(readFile(pauseFilePath(), 'utf8')).rejects.toThrow();
      await resumeBrainWriters();
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a quiet timeout names the gate', async () => {
    await expect(pauseBrainWriters({
      writePause: async () => {},
      waitUntilQuiet: async () => { throw new Error('writers did not quiesce within 60000ms'); },
    })).rejects.toThrow(/writers did not quiesce/);
  });
});
