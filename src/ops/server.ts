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
import {
  patchConfig, writeSchemaPack, writeSchemaPackJson, removeSchemaPack, seedSpaceRepo,
  takeGrantCredentialsFile, readSupervisorAuditTail, deleteCredentialDelivery,
} from './fileplane.ts';
import { resetBrainSchema } from './brainSchema.ts';
import { readBrainUsage } from './usage.ts';
import {
  commitAs, diffRange, exportRepoBundle, gitReadFile, gitTree, gitWriteFile, inspectRepos, probeTreePaths,
  revertRange, scaffoldFolders,
} from './git.ts';
import type { ScaffoldRequest } from './git.ts';
import { writeReport } from './reports.ts';
import { withAdvisoryLock } from './lock.ts';

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
  argv: string[], timeoutMs: number, runId?: string, env?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // argv array, no shell: no value can inject an argument (G2). `env` is
    // spread in ONLY when a caller supplies one: `env: undefined` inherits
    // just like omitting the key, but spelling it this way keeps every
    // existing caller's spawn byte-for-byte unchanged.
    const child = spawn('gbrain', argv, {
      ...(env ? { env } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

      if (url.pathname === '/fileplane/schema-pack-json') {
        const { name, manifest } = body as { name?: string; manifest?: unknown };
        if (!name || typeof manifest !== 'object' || manifest === null) return json({ error: 'name and manifest required' }, 400);
        await writeSchemaPackJson(name, manifest, { sql });
        return json({ ok: true, name });
      }

      if (url.pathname === '/fileplane/schema-pack-remove') {
        const { name } = body as { name?: string };
        if (!name) return json({ error: 'name required' }, 400);
        return json(await removeSchemaPack(name, { sql }));
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

      // A read, not a write: no advisory lock, and the path is
      // server-computed — the request carries only a line count (Task 6, U9).
      if (url.pathname === '/fileplane/audit-tail') {
        const requested = (body as { lines?: unknown }).lines;
        const lines = typeof requested === 'number' && Number.isFinite(requested) ? requested : 50;
        return json({ lines: await readSupervisorAuditTail(lines) });
      }

      // D8: gbrain's OWN spend, read through the published `get_usage` MCP
      // operation. Read-only, no lock. The request carries only a window in
      // days; the mint/revoke lifecycle lives in readBrainUsage.
      if (url.pathname === '/usage') {
        const requested = (body as { days?: unknown }).days;
        const days = typeof requested === 'number' && Number.isFinite(requested)
          ? requested
          : 30;
        return json(await readBrainUsage(days));
      }

      // A3: claim takes the ops-side --credentials-out file once, then deletes it.
      if (url.pathname === '/fileplane/take-grant-credentials') {
        const path = (body as { path?: unknown }).path;
        const credentials = await takeGrantCredentialsFile(path);
        return json({ credentials });
      }

      // F7: a revoked grant's private credential journal is the last copy of a
      // dead secret, and revoking the client does not remove it. The request
      // carries a client id, never a path.
      if (url.pathname === '/fileplane/delete-credential-journal') {
        const clientId = typeof body === 'object' && body !== null && 'clientId' in body
          ? body.clientId
          : undefined;
        return json(await deleteCredentialDelivery(clientId));
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

      // D9: the brain diff is the git range. Read-only, and a bad ref is an
      // explicit error rather than an empty range (`diffRange` checks exits).
      if (url.pathname === '/git/range') {
        const { sourceId, before, after } = body as { sourceId?: unknown; before?: unknown; after?: unknown };
        if (typeof sourceId !== 'string' || !sourceId) return json({ error: 'sourceId required' }, 400);
        if (typeof before !== 'string' || !before) return json({ error: 'before required' }, 400);
        if (typeof after !== 'string' || !after) return json({ error: 'after required' }, 400);
        return json(await diffRange(sourceId, before, after, { sql }));
      }

      // F16: the revert's purge guard. `gbrain delete <slug> --purge` unlinks a
      // page's markdown file when it is there, so a reverted path some writer
      // has since re-created is LIVE work. Read-only, and it answers from the
      // WORKING TREE — the revert's own file list is a memory of git. An
      // invalid sourceId, an unreadable repo or an unstat-able path throws (400)
      // rather than answering `onDisk: false`, which a caller would read as
      // permission to delete.
      if (url.pathname === '/git/path-exists') {
        const { sourceId, paths } = body as { sourceId?: unknown; paths?: unknown };
        if (typeof sourceId !== 'string' || !sourceId) return json({ error: 'sourceId required' }, 400);
        if (!Array.isArray(paths) || paths.length === 0) {
          return json({ error: 'paths must be a non-empty array' }, 400);
        }
        if (!paths.every((p) => typeof p === 'string')) {
          return json({ error: 'every path must be a string' }, 400);
        }
        return json(await probeTreePaths(sourceId, paths as string[], { sql }));
      }

      // Stage 1 browsing: the WORKING TREE a Space's pages live in, and one
      // file's bytes. Both READ and take NO lock — a reader never blocks a
      // writer, and traversal is rejected inside `git.ts` regardless of what
      // the caller sent, so this route cannot forget it.
      if (url.pathname === '/git/tree') {
        const { sourceId } = body as { sourceId?: unknown };
        if (typeof sourceId !== 'string' || !sourceId) return json({ error: 'sourceId required' }, 400);
        return json(await gitTree(sourceId, { sql }));
      }

      // Full history, every ref: the git bundle a member clones locally and
      // later pushes to a remote of their own. Binary, so it bypasses `json()`
      // and streams straight through — the ONE route here that is not JSON in,
      // JSON out.
      if (url.pathname === '/git/export') {
        const { sourceId } = body as { sourceId?: unknown };
        if (typeof sourceId !== 'string' || !sourceId) return json({ error: 'sourceId required' }, 400);
        const stream = await exportRepoBundle(sourceId);
        return new Response(stream, { headers: { 'content-type': 'application/octet-stream' } });
      }

      if (url.pathname === '/git/read-file') {
        const { sourceId, path } = body as { sourceId?: unknown; path?: unknown };
        if (typeof sourceId !== 'string' || !sourceId) return json({ error: 'sourceId required' }, 400);
        if (typeof path !== 'string' || !path) return json({ error: 'path required' }, 400);
        return json(await gitReadFile(sourceId, path, { sql }));
      }

      // Stage 2 write path: the expectedSha the caller read makes a concurrent
      // writer a `stale` RESULT (not a throw), and the actor signs the commit.
      // `content` may be an empty string, so it is type-checked only.
      if (url.pathname === '/git/write-file') {
        const { sourceId, path, content, expectedSha, actor, message } = body as {
          sourceId?: unknown; path?: unknown; content?: unknown; expectedSha?: unknown;
          message?: unknown; actor?: { name?: unknown; email?: unknown };
        };
        if (typeof sourceId !== 'string' || !sourceId) return json({ error: 'sourceId required' }, 400);
        if (typeof path !== 'string' || !path) return json({ error: 'path required' }, 400);
        if (typeof content !== 'string') return json({ error: 'content required' }, 400);
        if (typeof expectedSha !== 'string' || !expectedSha) return json({ error: 'expectedSha required' }, 400);
        if (typeof message !== 'string' || !message) return json({ error: 'message required' }, 400);
        if (!actor || typeof actor.name !== 'string' || typeof actor.email !== 'string') {
          return json({ error: 'actor name and email required' }, 400);
        }
        return json(await gitWriteFile(
          { sourceId, path, content, expectedSha, message, actor: { name: actor.name, email: actor.email } },
          { sql },
        ));
      }

      // Create-only folder scaffolding: one README.md per page type, one commit
      // per Space, under the repo lock. Every dir is validated inside git.ts
      // before the lock, so a traversing path never reaches a repo.
      if (url.pathname === '/git/scaffold') {
        return json(await scaffoldFolders(body as ScaffoldRequest, { sql }));
      }

      // D10 steps 1+2: the revert and the commit that signs it are ONE locked
      // sequence in `revertRange` — composing `commitAs` around a repo lock here
      // would reserve a second pooled connection and deadlock a small pool. The
      // two refusals (`conflict`, `nothing_to_revert`) come back as results, not
      // as thrown errors: they are choices the console renders.
      if (url.pathname === '/git/revert-range') {
        const { sourceId, before, after, actor, message } = body as {
          sourceId?: unknown; before?: unknown; after?: unknown; message?: unknown;
          actor?: { name?: unknown; email?: unknown };
        };
        if (typeof sourceId !== 'string' || !sourceId) return json({ error: 'sourceId required' }, 400);
        if (typeof before !== 'string' || !before) return json({ error: 'before required' }, 400);
        if (typeof after !== 'string' || !after) return json({ error: 'after required' }, 400);
        if (typeof message !== 'string' || !message) return json({ error: 'message required' }, 400);
        if (!actor || typeof actor.name !== 'string' || typeof actor.email !== 'string') {
          return json({ error: 'actor name and email required' }, 400);
        }
        return json(await revertRange(
          { sourceId, before, after, message, actor: { name: actor.name, email: actor.email } },
          { sql },
        ));
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
        const { spec, values, json: wantJson, dryRun, packOverride } = validateRequest(ops, body);
        const argv = buildArgv(spec, values, { json: wantJson, dryRun });
        const timeoutMs = Number((body as { timeoutMs?: number }).timeoutMs ?? 600_000);
        const runId = typeof (body as { runId?: unknown }).runId === 'string'
          ? (body as { runId: string }).runId : undefined;

        // The pack seam. The ONLY variable injected is GBRAIN_SCHEMA_PACK —
        // tier 2 of the resolution chain (docs/schema-pack-findings.md S1) —
        // scoped to this single spawn and never persisted, so the control
        // plane can inspect a pack's fully extends-resolved manifest WITHOUT
        // activating it. It must be the env tier with NO positional: a
        // positional pack name returns the UNRESOLVED manifest (S4, e.g.
        // gbrain-creator raw=1 vs effective=27), and reimplementing the
        // merge in TypeScript would be a false claim (S4).
        const exec = () => runGbrain(
          argv, timeoutMs, runId,
          packOverride ? { ...process.env, GBRAIN_SCHEMA_PACK: packOverride } : undefined,
        );

        // S3: a file-plane-writing operation (post-upgrade's config.json
        // read-modify-write, check-update's cache file) serializes through the
        // CONTROL database's advisory lock — enforced here, not by caller
        // discipline.
        const r = spec.requiresLock
          ? await withAdvisoryLock(sql, `fileplane:op:${spec.id}`, exec)
          : await exec();

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
