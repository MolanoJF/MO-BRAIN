import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpgradeEvent } from './types.ts';

export type Journal = { dir: string; runId: string; path: string };

/**
 * D2: this is the authority while the control plane is down. One journal
 * per run, one writer (scripts/upgrade.ts, the host CLI, per D1) — no
 * advisory lock is needed the way S3's file-plane writes need one, because
 * concurrent writers were never possible here in the first place.
 */
export async function openJournal(dir: string, runId: string): Promise<Journal> {
  const runDir = join(dir, runId);
  await mkdir(runDir, { recursive: true });
  return { dir, runId, path: join(runDir, 'journal.ndjson') };
}

export async function appendEvent(
  journal: Journal,
  input: { step: string; level?: UpgradeEvent['level']; message: string; data?: unknown },
): Promise<UpgradeEvent> {
  const existing = await readJournal(journal.dir, journal.runId);
  const seq = existing.length > 0 ? existing[existing.length - 1]!.seq + 1 : 1;
  const event: UpgradeEvent = {
    seq, at: new Date().toISOString(), step: input.step,
    level: input.level ?? 'info', message: input.message,
    ...(input.data !== undefined ? { data: input.data } : {}),
  };
  await appendFile(journal.path, JSON.stringify(event) + '\n');
  return event;
}

/**
 * A truncated LAST line is a crash mid-write (the process died between the
 * write() and its trailing '\n') and is dropped silently — it was never a
 * committed event, so dropping it is not data loss. A malformed line
 * anywhere else in the file is corruption of an already-committed event and
 * throws loudly; silently skipping it would mean replay quietly disagreeing
 * with what a prior reconcile pass (Task 13) already persisted.
 */
export async function readJournal(dir: string, runId: string): Promise<UpgradeEvent[]> {
  const path = join(dir, runId, 'journal.ndjson');
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const lines = (await file.text()).split('\n').filter((l) => l.length > 0);
  const events: UpgradeEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    try {
      events.push(JSON.parse(line) as UpgradeEvent);
    } catch {
      if (i !== lines.length - 1) {
        throw new Error(`journal ${path} is corrupt at line ${i + 1}: ${line.slice(0, 80)}`);
      }
      // else: a truncated trailing write — drop it, do not throw.
    }
  }
  return events;
}
