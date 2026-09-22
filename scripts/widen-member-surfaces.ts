#!/usr/bin/env bun
/**
 * One-shot: rescope every active Connection to its compiled surface (`full`),
 * so members minted before member skills can reach list_skills/get_skill.
 * Run inside the control-plane container. Idempotent: safe to re-run.
 */
import { widenConnectionSurfaces } from '../src/control/connections.ts';
import { closeDb } from '../src/control/db/client.ts';

const out = await widenConnectionSurfaces('system:widen-member-surfaces');
console.log(JSON.stringify(out, null, 2));
await closeDb();
process.exit(out.failed.length > 0 ? 1 : 0);
