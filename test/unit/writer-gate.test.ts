import { test, expect, describe } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  pauseBrainWriters,
  resumeBrainWriters,
  pauseFilePath,
  defaultWaitUntilQuiet,
  runGbrain,
} from '../../src/ops/writerGate.ts';
import type { Backend, GbrainChild } from '../../src/ops/writerGate.ts';

function backend(overrides: Partial<Backend> = {}): Backend {
  return {
    pid: 1,
    usename: 'gbrain',
    applicationName: 'gbrain worker',
    clientAddr: '172.20.0.7',
    backendType: 'client backend',
    state: 'idle',
    idleSeconds: 59.8,
    ...overrides,
  };
}

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

  test('never terminates a writer while the supervisor is still up', async () => {
    let clock = 0;
    const calls: number[][] = [];
    await expect(defaultWaitUntilQuiet({
      supervisorDown: async () => false,
      listBackends: async () => [backend({ pid: 7 })],
      terminate: async (pids) => { calls.push(pids); },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      timeoutMs: 1_000,
      graceMs: 100,
    })).rejects.toThrow(/supervisor up/);
    expect(calls).toEqual([]);
  });

  test('terminates the lingering client backend after the grace window, then returns', async () => {
    let clock = 0;
    let backends: Backend[] = [backend({ pid: 42 })];
    const calls: number[][] = [];
    await defaultWaitUntilQuiet({
      supervisorDown: async () => true,
      listBackends: async () => backends,
      terminate: async (pids) => { calls.push(pids); backends = []; },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      timeoutMs: 5_000,
      graceMs: 1_000,
    });
    expect(calls).toEqual([[42]]);
  });

  test('never terminates a non-client backend', async () => {
    let clock = 0;
    const calls: number[][] = [];
    await expect(defaultWaitUntilQuiet({
      supervisorDown: async () => true,
      listBackends: async () => [backend({ pid: 9, backendType: 'autovacuum worker', applicationName: '' })],
      terminate: async (pids) => { calls.push(pids); },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      timeoutMs: 2_000,
      graceMs: 500,
    })).rejects.toThrow(/writers did not quiesce/);
    expect(calls).toEqual([]);
  });

  test('the timeout names the lingering writer and the default deadline is below 60s', async () => {
    let clock = 0;
    await expect(defaultWaitUntilQuiet({
      supervisorDown: async () => true,
      listBackends: async () => [backend({ pid: 5, applicationName: 'gbrain worker' })],
      terminate: async () => {},
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    })).rejects.toThrow(/within 45000ms[\s\S]*app="gbrain worker"/);
  });

  test('a slow probe near the deadline still throws within the bound', async () => {
    const timeoutMs = 45_000;
    let clock = 0;
    let thrownAt: number | null = null;
    try {
      await defaultWaitUntilQuiet({
        // A hung probe consumes its whole bounded budget each poll; the
        // deadline must be enforced before the next probe, not after an
        // unbounded wait, so the throw stays within timeoutMs + one poll.
        supervisorDown: async (probeTimeoutMs) => { clock += probeTimeoutMs; return false; },
        listBackends: async () => [backend({ pid: 7 })],
        terminate: async () => {},
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        graceMs: 1_000,
        timeoutMs,
      });
    } catch {
      thrownAt = clock;
    }
    expect(thrownAt).not.toBeNull();
    expect(thrownAt!).toBeGreaterThan(timeoutMs);
    expect(thrownAt! - timeoutMs).toBeLessThanOrEqual(5_000);
  });

  // M1: a probe child that ignores SIGTERM must not hang the await forever; the
  // 45 s deadline is only honest if runGbrain force-kills after a short grace.
  test('runGbrain escalates to SIGKILL when a TERM-resistant child never closes', async () => {
    const signals: string[] = [];
    let close: ((code: number | null) => void) | undefined;
    const child: GbrainChild = {
      kill: (signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') close?.(137);
        return true;
      },
      stderr: { on: () => {} },
      on: (event, listener) => { if (event === 'close') close = listener; return {}; },
    };
    const result = await runGbrain(['jobs', 'supervisor', 'status', '--json'], 10, {
      spawn: () => child, killGraceMs: 20,
    });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result.exitCode).toBe(137);
  });

  // The kill timer is cancelled when the child does close on SIGTERM, so a clean
  // shutdown is never force-killed after the fact.
  test('runGbrain clears the SIGKILL timer when the child closes on SIGTERM', async () => {
    const signals: string[] = [];
    let close: ((code: number | null) => void) | undefined;
    const child: GbrainChild = {
      kill: (signal) => { signals.push(signal); queueMicrotask(() => close?.(0)); return true; },
      stderr: { on: () => {} },
      on: (event, listener) => { if (event === 'close') close = listener; return {}; },
    };
    const result = await runGbrain(['x'], 5, { spawn: () => child, killGraceMs: 50 });
    expect(signals).toEqual(['SIGTERM']);
    expect(result.exitCode).toBe(0);
  });
});
