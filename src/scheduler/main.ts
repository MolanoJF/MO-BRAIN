#!/usr/bin/env bun
/**
 * The scheduler service. Two loops in one process:
 *
 *   leader  — gated by ONE pg_try_advisory_lock in the control DB, materializes
 *             due occurrences into schedule_runs and reclaims dead leases.
 *   worker  — claims pending runs with FOR UPDATE SKIP LOCKED and executes one
 *             allowlisted gbrain command per run through the ops RPC.
 *
 * Scale is replicas: every replica runs both loops, exactly one ever holds the
 * leader lock, and SKIP LOCKED keeps the workers from colliding.
 *
 * This service replaces gbrain's own `autopilot` crontab install path, which is
 * a silent no-op or a duplicate-scheduler bug inside a container; the literal
 * `gbrain autopilot` + install flag is what scripts/lint-forbidden.ts forbids,
 * and that guard matches raw text, so this comment must not spell it out.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { runMigrations, closeDb } from '../control/db/client.ts';
import { withLeadership } from './leader.ts';
import { materializeDue } from './materialize.ts';
import { claimNextRun, reclaimExpiredLeases } from './claim.ts';
import { executeRun } from './execute.ts';

export const WORKER_ID = `${process.env.HOSTNAME ?? 'scheduler'}-${randomUUID().slice(0, 8)}`;

const TICK_MS = Number(process.env.SCHEDULER_TICK_MS ?? 15_000);
/** Bound how much one worker pass does, so shutdown is never far away. */
export const MAX_RUNS_PER_PASS = 4;

let stopping = false;

export async function tickOnce(sql: postgres.Sql, nowMs: number): Promise<void> {
  await withLeadership(sql, async () => {
    await reclaimExpiredLeases(nowMs);
    const results = await materializeDue(nowMs);
    for (const r of results) {
      if (r.error) console.error(`[scheduler] schedule ${r.scheduleId} tick failed: ${r.error}`);
    }
  });
}

/** Returns true when it did work, so the caller can drain a backlog promptly. */
export async function workerOnce(nowMs: number): Promise<boolean> {
  // D2: this consumer owns the command lane only. The filter lives inside the
  // claim's FOR UPDATE SKIP LOCKED select, so an `agent_prompt` row — which the
  // runner claims over HTTP — is never locked here, never counted against a
  // queue cap and never starves this lane.
  const claimed = await claimNextRun(WORKER_ID, nowMs, { jobTypes: ['gbrain_command'] });
  if (claimed === 'none') return false;
  try {
    await executeRun(claimed);
  } catch (e) {
    // executeRun owns its own failure paths; this is the last backstop so one
    // bad run cannot kill the loop.
    console.error(`[scheduler] run ${claimed.run.id} threw:`, e);
  }
  return true;
}

async function main(): Promise<void> {
  await runMigrations();
  const sql = postgres(process.env.CONTROL_DATABASE_URL!, { max: 4 });

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[scheduler] ${signal}: draining`);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log(`[scheduler] ${WORKER_ID} up, tick ${TICK_MS}ms`);
  while (!stopping) {
    const started = Date.now();
    try {
      await tickOnce(sql, started);
      for (let i = 0; i < MAX_RUNS_PER_PASS && !stopping; i++) {
        if (!(await workerOnce(Date.now()))) break;
      }
    } catch (e) {
      console.error('[scheduler] tick failed:', e);
    }
    const elapsed = Date.now() - started;
    if (!stopping && elapsed < TICK_MS) await Bun.sleep(TICK_MS - elapsed);
  }

  await sql.end();
  await closeDb();
  console.log('[scheduler] stopped');
}

if (import.meta.main) await main();
