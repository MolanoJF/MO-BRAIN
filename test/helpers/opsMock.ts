// test/helpers/opsMock.ts
import { mock } from 'bun:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
process.env.PUBLIC_URL ??= 'http://127.0.0.1:3131';

export type CallOpts = { json?: boolean; dryRun?: boolean; timeoutMs?: number };
export type OpsCall = { op: string; params?: Record<string, unknown>; opts?: CallOpts };
export type OpsResult = {
  ok: boolean; exitCode: number; argv: string[];
  stdout: string; stderr: string; json: unknown;
};

export type OpsMock = {
  calls: OpsCall[];
  seedSpaceCalls: string[];
  /** Client ids passed to deleteCredentialJournal, in call order. */
  journalDeletes: string[];
  reset(): void;
  /** When set, replaces the default handoff. Pass null to restore it. */
  setTake(handler: ((path: string) => Promise<unknown> | unknown) | null): void;
  /** When set, may rewrite a callOps result (stdout for config.get). */
  setCallDecorator(fn: ((op: string, result: OpsResult) => OpsResult) | null): void;
};

const HANDOFF = {
  version: 1,
  mcp_url: 'http://127.0.0.1:3131/mcp',
  issuer_url: 'http://127.0.0.1:3131',
  client_id: 'gbrain_cl_mock_handoff',
  client_secret: 'not-a-real-secret-not-a-real-secret-not-a-real',
  access_token: 'gbrain_at_mock_handoff',
  expires_at: 1789657429,
  profile: 'memory-writer',
  harness: 'generic',
  source_id: 'customers',
};

export function installOpsMock(): OpsMock {
  const calls: OpsCall[] = [];
  const seedSpaceCalls: string[] = [];
  const journalDeletes: string[] = [];
  let grantSeq = 0;
  let takeHandler: ((path: string) => Promise<unknown> | unknown) | null = null;
  let callDecorator: ((op: string, result: OpsResult) => OpsResult) | null = null;

  const grantJson = (dryRun: boolean): unknown => {
    if (dryRun) return { status: 'preview', grant: { profile: 'memory-writer', sourceId: 'customers' } };
    const n = grantSeq++;
    return {
      client_id: `gbrain_cl_mock_${n}`,
      mcp_url: 'http://127.0.0.1:3131/mcp',
      profile: 'memory-writer',
      harness: 'generic',
      source_id: 'customers',
      expires_at: null,
      renewable: true,
      credentials: 'private-file',
    };
  };

  const ok = (op: string, opts?: CallOpts): OpsResult => ({
    ok: true, exitCode: 0, argv: ['gbrain', ...op.split('.')], stdout: '{}', stderr: '',
    json: op === 'mcp.grant' ? grantJson(Boolean(opts?.dryRun)) : { ok: true },
  });

  mock.module('../../src/control/opsClient.ts', () => ({
    brainUsage: async () => { throw new Error('ops unreachable'); },
    callOps: async (op: string, params?: Record<string, unknown>, opts?: CallOpts) => {
      calls.push({ op, params, opts });
      const result = ok(op, opts);
      return callDecorator ? callDecorator(op, result) : result;
    },
    patchFilePlaneConfig: async () => {},
    putSchemaPack: async () => {},
    putSchemaPackJson: async () => {},
    gitScaffold: async () => ({ created: [], skipped: [], sha: null }),
    removeSchemaPack: async () => ({ removed: false }),
    seedSpace: async (sourceId: string) => { seedSpaceCalls.push(sourceId); },
    resetBrainSchema: async () => {},
    takeGrantCredentials: async (path: string) => {
      if (takeHandler) return takeHandler(path);
      return HANDOFF;
    },
    deleteCredentialJournal: async (clientId: string) => {
      journalDeletes.push(clientId);
      return { deleted: true };
    },
    opsHealthy: async () => true,
    commitAsMember: async () => ({ committed: false, sha: null }),
    inspectRepos: async () => [],
    writeReport: async () => ({ relPath: '', committed: false, sha: null }),
    cancelRun: async () => ({ cancelled: false }),
    gitRange: async () => ({ commits: [], files: [] }),
    gitPathExists: async () => ({ paths: [] }),
    gitRevertRange: async () => ({ outcome: 'nothing_to_revert' }),
    auditTail: async () => [],
    gitTree: async (sourceId: string) => ({ sourceId, root: `/repos/${sourceId}`, entries: [] }),
    gitExportBundle: async () => new Response(null),
    gitReadFile: async () => ({ content: '', sha: '', size: 0 }),
    gitWriteFile: async () => ({ committed: true, sha: 'written-sha' }),
  }));

  return {
    calls,
    seedSpaceCalls,
    journalDeletes,
    reset() {
      calls.length = 0;
      seedSpaceCalls.length = 0;
      journalDeletes.length = 0;
      takeHandler = null;
      callDecorator = null;
    },
    setTake(handler) { takeHandler = handler; },
    setCallDecorator(fn) { callDecorator = fn; },
  };
}
