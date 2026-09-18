/**
 * The per-run workspace: one fresh directory under `/tmp/agent-run/<runId>/`.
 *
 * P5 measured the container's minimal writable set: **`/tmp` alone**. The rootfs
 * is read-only, `/tmp` is a tmpfs, and `/home/runner` is deliberately unwritable
 * — so this directory is ephemeral by construction. It dies with the container,
 * and there is no `/workspace` tmpfs to put it in (the plan's original text
 * named one; the correction recorded in the plan and the findings removed it).
 *
 * Three rules, all of them load-bearing for a container that executes code an
 * LLM chose:
 *
 *   1. **Never a bind mount of `GBRAIN_HOME` or of a brain repo.** The compose
 *      file gives this service `volumes: []`; this module only ever creates a
 *      directory inside its own root.
 *   2. **Never reused.** `createWorkspace` fails if the directory already
 *      exists, because a reused directory would carry a previous run's files
 *      into a run that believes it has a clean one.
 *   3. **`destroyWorkspace` on every path, including the throw.** It is
 *      recursive and idempotent so the caller can put it in a `finally` without
 *      having to reason about how far the run got.
 *
 * `AGENT_RUN_ROOT` overrides the root for a host run (and for the unit tests,
 * which must not write to `/tmp`). It is an override of the PATH only: the
 * default is the measured container location, and the run-id guard below is what
 * keeps either root honest.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/** D5/Task 3: the one measured writable path in the container. */
export const WORKSPACE_ROOT = process.env.AGENT_RUN_ROOT ?? '/tmp/agent-run';

/**
 * A run id becomes a path segment, so it is validated as one instead of being
 * sanitised into something that silently points elsewhere. The control plane
 * issues UUIDs; a leading `-`/`.` and any separator are refused rather than
 * fixed, because a run whose workspace is somewhere the runner did not intend is
 * a run writing to a file nobody is watching.
 */
function assertRunId(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '.' || runId === '..') {
    throw new Error(`invalid runId for a workspace path: ${JSON.stringify(runId)}`);
  }
  return runId;
}

/** The path a run's workspace would occupy. Pure, so callers can name it first. */
export function workspacePath(runId: string, root: string = WORKSPACE_ROOT): string {
  return join(root, assertRunId(runId));
}

/**
 * Create the run's workspace and return its path.
 *
 * The root is created first (recursively, so a container start is not a special
 * case), then the leaf with a non-recursive `mkdir`: that is what makes "never
 * reused" enforced by the filesystem rather than by a check-then-create race.
 */
export async function createWorkspace(
  runId: string,
  root: string = WORKSPACE_ROOT,
): Promise<string> {
  const path = workspacePath(runId, root);
  await mkdir(resolve(root), { recursive: true, mode: 0o700 });
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`workspace already exists, refusing to reuse it: ${path}`);
    }
    throw e;
  }
  return path;
}

/**
 * Remove the run's workspace recursively. Idempotent: a run that never started,
 * or one whose workspace was already destroyed, is not an error — the caller is
 * in a `finally` and must not have to know.
 *
 * An invalid run id is refused rather than repaired, so this can never be talked
 * into deleting a path outside the root.
 */
export async function destroyWorkspace(
  runId: string,
  root: string = WORKSPACE_ROOT,
): Promise<void> {
  const path = workspacePath(runId, root);
  // Belt: the guard above already refuses a separator, so a child path is the
  // only reachable outcome. It is asserted anyway, because the cost of being
  // wrong here is `rm -rf` outside the root.
  if (!resolve(path).startsWith(resolve(root) + sep)) {
    throw new Error(`refusing to destroy a path outside the workspace root: ${path}`);
  }
  await rm(path, { recursive: true, force: true, maxRetries: 3 });
}
