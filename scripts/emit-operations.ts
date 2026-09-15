#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { OPERATIONS } from '../src/contracts/registry.ts';

const version = process.env.GBRAIN_VERSION ?? '0.50.0.0';
const dir = `contracts/v${version}`;
await mkdir(dir, { recursive: true });

const payload = {
  gbrainVersion: version,
  generatedAt: new Date().toISOString(),
  // Slice 1's gbrain-ops RPC server exposes exactly these and nothing else.
  // There is no passthrough (G2, S2).
  operations: Object.values(OPERATIONS).sort((a, b) => a.id.localeCompare(b.id)),
};

await Bun.write(`${dir}/operations.json`, JSON.stringify(payload, null, 2) + '\n');
console.log(`wrote ${dir}/operations.json — ${payload.operations.length} operations`);
