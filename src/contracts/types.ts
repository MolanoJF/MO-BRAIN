/** How a param renders into argv. */
export type ParamKind = 'flag' | 'value' | 'list';

export type ParamSpec = {
  /** Our camelCase name, used as the key in ParamValues. */
  name: string;
  /** The exact gbrain flag, e.g. '--federated-read'. */
  flag: string;
  kind: ParamKind;
  required?: boolean;
  /** Redact this value in logs, receipts and audit rows. */
  secret?: boolean;
};

/**
 * Privilege tells Slice 1 which container may run the operation.
 * 'brain-db' operations need the brain DATABASE_URL and RW GBRAIN_HOME (V8),
 * so they run only in gbrain-ops — never in the control plane (S2).
 */
export type Privilege = 'brain-db' | 'read-only';

export type OperationSpec = {
  /** Stable id, e.g. 'mcp.grant'. */
  id: string;
  /** Fixed argv prefix, e.g. ['mcp', 'grant']. */
  argv: readonly string[];
  params: readonly ParamSpec[];
  supportsJson: boolean;
  supportsDryRun: boolean;
  privilege: Privilege;
  /** Exit codes that are not failures. Anything else is an error. */
  okExitCodes: readonly number[];
};

export type ParamValues = Record<string, string | string[] | boolean | undefined>;

export type ExecResult<T = unknown> = {
  /** Redacted — safe to log. */
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Parsed --json payload, or null when the operation emitted none. */
  json: T | null;
};

export const REDACTED = '***REDACTED***';
