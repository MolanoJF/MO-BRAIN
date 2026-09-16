#!/usr/bin/env bun
/**
 * gbrain-ops: the privilege boundary (S2). Holds the brain DATABASE_URL and
 * RW GBRAIN_HOME; the control plane holds neither and reaches gbrain only
 * through this allowlisted RPC on the private ops-net.
 */
import { SQL } from 'bun';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { loadOperations, validateRequest } from './dispatch.ts';
import type { OpsResponse } from './dispatch.ts';
import { buildArgv, redactArgv } from '../contracts/argv.ts';
import { patchConfig, writeSchemaPack, seedSpaceRepo, takeGrantCredentialsFile } from './fileplane.ts';
import { resetBrainSchema } from './brainSchema.ts';
import { commitAs, inspectRepos } from './git.ts';
import { writeReport } from './reports.ts';

const PORT = Number(process.env.OPS_RPC_PORT ?? 3140);
const TOKEN = process.env.OPS_RPC_TOKEN;
if (!TOKEN) throw new Error('OPS_RPC_TOKEN is required');

const ops = loadOperations();
const sql = new SQL(process.env.CONTROL_DATABASE_URL!);

function authorized(req: Request): boolean {
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Constant-time compare so the token cannot be discovered by timing.
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN!);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** runId -> live child. gbrain-ops is a single container, so an in-process map
 *  is the whole truth; a restart kills the children with it. */
const liveRuns = new Map<string, ReturnType<typeof spawn>>();

function runGbrain(
  argv: string[], timeoutMs: number, runId?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // argv array, no shell: no value can inject an argument (G2).
    const child = spawn('gbrain', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (runId) liveRuns.set(runId, child);
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (runId) liveRuns.delete(runId);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Index of the bracket closing the value that opens at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The LAST balanced JSON value on stdout — the convention `execOperation`
 * (src/contracts/exec.ts) documents and its clients implement: gbrain prints
 * prose and progress JSON before its machine-readable receipt, and `sync`
 * prints the embed cost-gate object ahead of its receipt. Parsing from the
 * FIRST `{` makes `json` null for exactly the command the scheduler runs most,
 * and a null receipt is not "nothing changed" — it is unknown.
 */
function lastJsonValue(stdout: string): unknown {
  let found: unknown = null;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i]!;
    if (ch !== '{' && ch !== '[') continue;
    const end = balancedEnd(stdout, i);
    if (end < 0) continue;
    try {
      found = JSON.parse(stdout.slice(i, end + 1)) as unknown;
      i = end; // anything inside this value belongs to it, not to a later one
    } catch { /* not JSON: keep scanning for a later value */ }
  }
  return found;
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/healthz') return json({ ok: true });
    if (!authorized(req)) return json({ error: 'unauthorized' }, 401);
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    try {
      const body = await req.json();

      if (url.pathname === '/fileplane/config') {
        const patch = (body as { patch?: Record<string, unknown> }).patch;
        if (!patch || typeof patch !== 'object') return json({ error: 'patch required' }, 400);
        await patchConfig(patch, { sql });
        // S3c: never echo the patch back — it carries provider API keys.
        return json({ ok: true, keys: Object.keys(patch) });
      }

      if (url.pathname === '/fileplane/schema-pack') {
        const { name, yaml } = body as { name?: string; yaml?: string };
        if (!name || !yaml) return json({ error: 'name and yaml required' }, 400);
        await writeSchemaPack(name, yaml, { sql });
        return json({ ok: true, name });
      }

      if (url.pathname === '/fileplane/seed-space') {
        const { sourceId } = body as { sourceId?: string };
        if (!sourceId || typeof sourceId !== 'string') return json({ error: 'sourceId required' }, 400);
        const dir = await seedSpaceRepo(sourceId, { sql });
        return json({ ok: true, sourceId, path: dir });
      }

      // First intentional init: clear the worker's cold-start 1280-d template.
      if (url.pathname === '/fileplane/reset-brain-schema') {
        await resetBrainSchema();
        return json({ ok: true });
      }

      // A3: claim takes the ops-side --credentials-out file once, then deletes it.
      if (url.pathname === '/fileplane/take-grant-credentials') {
        const path = (body as { path?: unknown }).path;
        const credentials = await takeGrantCredentialsFile(path);
        return json({ credentials });
      }

      // Actor is identity data fed to `git -c`; never interpolated into a shell (G2).
      if (url.pathname === '/git/commit') {
        const { sourceId, actor, message } = body as {
          sourceId?: unknown;
          actor?: { name?: unknown; email?: unknown };
          message?: unknown;
        };
        if (typeof sourceId !== 'string' || !sourceId) return json({ error: 'sourceId required' }, 400);
        if (typeof message !== 'string' || !message) return json({ error: 'message required' }, 400);
        if (!actor || typeof actor.name !== 'string' || typeof actor.email !== 'string') {
          return json({ error: 'actor name and email required' }, 400);
        }
        const result = await commitAs(sourceId, { name: actor.name, email: actor.email }, message, { sql });
        return json(result);
      }

      if (url.pathname === '/git/inspect') {
        return json({ repos: await inspectRepos() });
      }

      // Overlap policy 'kill_previous'. Aborting the control-plane fetch does
      // NOT kill the ops-side child, so cancellation needs its own door.
      if (url.pathname === '/rpc/cancel') {
        const runId = (body as { runId?: unknown }).runId;
        if (typeof runId !== 'string' || !runId) return json({ error: 'runId required' }, 400);
        const child = liveRuns.get(runId);
        if (!child) return json({ cancelled: false });
        child.kill('SIGTERM');
        return json({ cancelled: true });
      }

      // Report writes are file-plane writes: advisory-locked, atomic, and
      // committed as the member who owns the Connection (S3, S4).
      if (url.pathname === '/fileplane/report') {
        const { sourceId, job, stamp, reportBody, actor } = body as {
          sourceId?: unknown; job?: unknown; stamp?: unknown; reportBody?: unknown;
          actor?: { name?: unknown; email?: unknown };
        };
        if (typeof sourceId !== 'string' || !sourceId) return json({ error: 'sourceId required' }, 400);
        if (typeof job !== 'string' || !job) return json({ error: 'job required' }, 400);
        if (typeof stamp !== 'string' || !stamp) return json({ error: 'stamp required' }, 400);
        if (typeof reportBody !== 'string') return json({ error: 'reportBody required' }, 400);
        if (!actor || typeof actor.name !== 'string' || typeof actor.email !== 'string') {
          return json({ error: 'actor name and email required' }, 400);
        }
        const result = await writeReport(
          { sourceId, job, stamp, body: reportBody, actor: { name: actor.name, email: actor.email } },
          { sql },
        );
        return json(result);
      }

      if (url.pathname === '/rpc') {
        const { spec, values, json: wantJson, dryRun } = validateRequest(ops, body);
        const argv = buildArgv(spec, values, { json: wantJson, dryRun });
        const timeoutMs = Number((body as { timeoutMs?: number }).timeoutMs ?? 600_000);
        const runId = typeof (body as { runId?: unknown }).runId === 'string'
          ? (body as { runId: string }).runId : undefined;
        const r = await runGbrain(argv, timeoutMs, runId);

        let parsed: unknown = null;
        if (wantJson) parsed = lastJsonValue(r.stdout);

        const res: OpsResponse = {
          ok: spec.okExitCodes.includes(r.exitCode),
          exitCode: r.exitCode,
          argv: redactArgv(spec, ['gbrain', ...argv]),
          stdout: r.stdout, stderr: r.stderr, json: parsed,
        };
        return json(res);
      }

      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  },
});

console.log(`gbrain-ops rpc listening on :${PORT} with ${Object.keys(ops).length} allowlisted operations`);
