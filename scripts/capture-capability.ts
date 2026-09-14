#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { captureCapability, diffCapability } from '../src/contracts/capability.ts';
import type { CapabilitySnapshot } from '../src/contracts/capability.ts';

const serveBaseUrl = process.env.SERVE_BASE_URL ?? 'http://127.0.0.1:3131';
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
    drift.toolsAdded.length || drift.toolsRemoved.length ||
    drift.adaptersAdded.length || drift.adaptersRemoved.length;
  console.log(changed ? 'DRIFT DETECTED' : 'no drift');
  console.log(JSON.stringify(drift, null, 2));
}

await Bun.write(file, JSON.stringify(snap, null, 2) + '\n');
console.log(`wrote ${file}`);
