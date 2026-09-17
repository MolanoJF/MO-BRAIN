export const UPGRADE_RUN_STATES = [
  'planned', 'preflight_ok', 'quiesced', 'snapshot_taken', 'swapped', 'migrated',
  'playbooks_applied', 'gated_ok', 'completed', 'failed',
  'rolling_back', 'rolled_back', 'rollback_failed',
] as const;

/** Must name exactly the values in schema.ts's `upgrade_run_state_valid` CHECK
 * (Task 3) — a unit test above asserts the two agree, because drift here is a
 * silent DB write failure in production, not a type error. */
export type UpgradeRunState = typeof UPGRADE_RUN_STATES[number];

export type UpgradeEvent = {
  seq: number;
  at: string;
  step: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
};

export type SnapshotArtifact = { name: string; path: string; bytes: number; sha256: string };

export type SnapshotManifest = {
  id: string;
  runId: string;
  takenAt: string;
  fromVersion: string;
  driver: string;
  artifacts: SnapshotArtifact[];
  /** D3: which services were stopped, and the supervisor drain proof (Task 6). */
  quiesce: { stoppedServices: string[]; drainProofs: Record<string, unknown> };
};

export type DoctorCheckSummary = { name: string; status: 'ok' | 'warn' | 'fail'; category?: string };

/** D5's baseline half — captured before the swap, compared after by compareDoctor (Task 12). */
export type DoctorBaseline = {
  capturedAt: string;
  status: string;
  healthScore: number;
  checks: DoctorCheckSummary[];
  /** Recorded for trend only; the gate NEVER reads these (D5). `doctor --json`
   *  carries them and the Task 11 fixture names them, so they are optional
   *  rather than forbidden. */
  gbrainVersion?: string;
  categoryScores?: Record<string, number>;
};

/**
 * Threaded through every playbook step and the host executor (Task 9, Task 11).
 *
 * Task 11's `fakeCtx` fixture is authoritative for this shape (the coordinator
 * note): `organizationId`/`journalDir` from Task 4's draft were never consumed,
 * and `dryRun`/`upgradeDir`/`envPath`/`compose`/`journal`/`now` are what the
 * host CLI, the digest and rollback actually read.
 */
export type UpgradeContext = {
  runId: string;
  fromVersion: string;
  toVersion: string;
  dryRun: boolean;
  upgradeDir: string;
  envPath: string;
  compose: readonly string[];
  journal: import('./journal.ts').Journal | null;
  now: () => Date;
};
