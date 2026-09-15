#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { captureCapability, diffCapability } from '../src/contracts/capability.ts';
import type { CapabilitySnapshot } from '../src/contracts/capability.ts';
import { composeExec } from '../src/docker/host.ts';

const COMPOSE_FILE = 'compose/docker-compose.slice0.yml';
const serveBaseUrl = process.env.SERVE_BASE_URL ?? 'http://127.0.0.1:3131';

/**
 * The Docker half of Task 11 was never exercised before: captureCapability's
 * well-known probe needs a live `gbrain serve` to hit, and nothing started
 * one. Spawn it the same way test/contract/discovery.contract.test.ts does —
 * `docker compose exec -T gbrain-ops gbrain serve ...` — bound to loopback
 * only, since this probe never needs to leave the container.
 */
function startServe() {
  return Bun.spawn(
    ['docker', 'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'gbrain-ops',
      'gbrain', 'serve', '--http', '--bind', '127.0.0.1', '--port', '3131'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
}

/**
 * Poll rather than sleep blindly. bun fetch(), not curl — Work Item I: the
 * pinned image carries neither.
 */
async function waitForServe(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const probe = await composeExec('gbrain-ops', [
      'bun', '-e',
      `const r = await fetch(${JSON.stringify(`${serveBaseUrl}/.well-known/gbrain`)}).catch(() => null); ` +
      'if (r && r.ok) console.log("ready");',
    ]);
    if (probe.stdout.includes('ready')) return;
    await Bun.sleep(1000);
  }
  throw new Error(`gbrain serve did not become ready at ${serveBaseUrl} within 60s`);
}

/**
 * Plan defect (Work Item L, Task 10): `-T` docker-exec means the local
 * client's `.kill()` never propagates to the remote process it spawned —
 * confirmed empirically (killing the client leaves `gbrain serve` and its
 * worker fork alive in the container). Reap the remote PID directly by
 * scanning /proc, same as discovery.contract.test.ts's killRemoteServe.
 */
async function stopServe(local: ReturnType<typeof startServe>): Promise<void> {
  local.kill();
  await composeExec('gbrain-ops', [
    'bun', '-e',
    "const fs=require('fs'); for (const pid of fs.readdirSync('/proc')) { " +
    "if (!/^[0-9]+$/.test(pid) || Number(pid) === process.pid) continue; " +
    "try { const cmd = fs.readFileSync('/proc/'+pid+'/cmdline','utf8'); " +
    "if (cmd.indexOf('gbrain') >= 0 && cmd.indexOf('serve') >= 0) process.kill(Number(pid), 'SIGTERM'); " +
    "} catch (e) {} }",
  ]);
}

const serve = startServe();
try {
  await waitForServe();

  const snap = await captureCapability({ serveBaseUrl });

  const dir = `contracts/v${snap.gbrainVersion}`;
  await mkdir(dir, { recursive: true });
  const file = `${dir}/capability.json`;

  const existing = await Bun.file(file).exists()
    ? (await Bun.file(file).json()) as CapabilitySnapshot
    : null;

  if (existing) {
    const drift = diffCapability(existing, snap);
    const changed =
      drift.versionChanged || drift.profilesChanged ||
      drift.toolsAdded.length > 0 || drift.toolsRemoved.length > 0 ||
      drift.adaptersAdded.length > 0 || drift.adaptersRemoved.length > 0;
    console.log(changed ? 'DRIFT DETECTED' : 'no drift');
    console.log(JSON.stringify(drift, null, 2));
  }

  if (snap.wellKnown === null) {
    throw new Error('captured snapshot has wellKnown: null — the serve probe did not get a reply');
  }

  await Bun.write(file, JSON.stringify(snap, null, 2) + '\n');
  console.log(`wrote ${file}`);
} finally {
  await stopServe(serve);
}
