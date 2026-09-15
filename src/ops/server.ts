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
import { patchConfig, writeSchemaPack, seedSpaceRepo } from './fileplane.ts';
import { resetBrainSchema } from './brainSchema.ts';

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

function runGbrain(argv: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // argv array, no shell: no value can inject an argument (G2).
    const child = spawn('gbrain', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, stdout, stderr }); });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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

      if (url.pathname === '/rpc') {
        const { spec, values, json: wantJson, dryRun } = validateRequest(ops, body);
        const argv = buildArgv(spec, values, { json: wantJson, dryRun });
        const timeoutMs = Number((body as { timeoutMs?: number }).timeoutMs ?? 600_000);
        const r = await runGbrain(argv, timeoutMs);

        let parsed: unknown = null;
        if (wantJson) {
          const t = r.stdout.trim();
          const idx = Math.min(...[t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0));
          if (Number.isFinite(idx) && idx >= 0) { try { parsed = JSON.parse(t.slice(idx)); } catch {} }
        }

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
