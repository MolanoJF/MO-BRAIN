import { test, expect, describe } from 'bun:test';
import { buildArgv, redactArgv } from '../../src/contracts/argv.ts';
import type { OperationSpec } from '../../src/contracts/types.ts';

const INIT: OperationSpec = {
  id: 'init',
  argv: ['init'],
  params: [
    { name: 'nonInteractive', flag: '--non-interactive', kind: 'flag' },
    { name: 'url', flag: '--url', kind: 'value', required: true, secret: true },
    { name: 'embeddingModel', flag: '--embedding-model', kind: 'value' },
  ],
  supportsJson: false,
  supportsDryRun: false,
  privilege: 'brain-db',
  okExitCodes: [0],
};

const GRANT: OperationSpec = {
  id: 'mcp.grant',
  argv: ['mcp', 'grant'],
  params: [
    { name: 'harness', flag: '--harness', kind: 'value', required: true },
    { name: 'source', flag: '--source', kind: 'value', required: true },
    { name: 'federatedRead', flag: '--federated-read', kind: 'list' },
  ],
  supportsJson: true,
  supportsDryRun: true,
  privilege: 'brain-db',
  okExitCodes: [0],
};

describe('buildArgv', () => {
  test('emits the fixed prefix then flag/value pairs', () => {
    expect(buildArgv(INIT, { nonInteractive: true, url: 'postgres://x/y' }))
      .toEqual(['init', '--non-interactive', '--url', 'postgres://x/y']);
  });

  test('joins list params with commas', () => {
    expect(buildArgv(GRANT, { harness: 'claude-code', source: 'customers', federatedRead: ['customers', 'shared'] }))
      .toEqual(['mcp', 'grant', '--harness', 'claude-code', '--source', 'customers',
                '--federated-read', 'customers,shared']);
  });

  test('omits absent optional params and false flags', () => {
    expect(buildArgv(INIT, { url: 'postgres://x/y', nonInteractive: false }))
      .toEqual(['init', '--url', 'postgres://x/y']);
  });

  test('throws when a required param is missing', () => {
    expect(() => buildArgv(INIT, {})).toThrow('missing required param url');
  });

  test('appends --json only when the operation declares support', () => {
    expect(buildArgv(GRANT, { harness: 'h', source: 's' }, { json: true }).at(-1)).toBe('--json');
    expect(() => buildArgv(INIT, { url: 'u' }, { json: true }))
      .toThrow('init does not support --json');
  });

  test('appends --dry-run only when the operation declares support', () => {
    expect(buildArgv(GRANT, { harness: 'h', source: 's' }, { dryRun: true })).toContain('--dry-run');
    expect(() => buildArgv(INIT, { url: 'u' }, { dryRun: true }))
      .toThrow('init does not support --dry-run');
  });

  // G2: argv arrays, never shell strings. A metacharacter-laden value must
  // survive as exactly ONE element and never be split or interpreted.
  test('keeps shell metacharacters inside a single argv element', () => {
    const argv = buildArgv(INIT, { url: 'postgres://u:p@h/db; rm -rf / #' });
    expect(argv).toEqual(['init', '--url', 'postgres://u:p@h/db; rm -rf / #']);
    expect(argv).toHaveLength(3);
  });

  test('rejects an unknown param rather than silently dropping it', () => {
    expect(() => buildArgv(INIT, { url: 'u', bogus: 'x' })).toThrow('unknown param bogus');
  });

  test('emits positional params without a flag', () => {
    const CONFIG_SET: OperationSpec = {
      id: 'config.set',
      argv: ['config', 'set'],
      params: [
        { name: 'key', flag: '', kind: 'value', required: true },
        { name: 'value', flag: '', kind: 'value', required: true },
      ],
      supportsJson: false, supportsDryRun: false, privilege: 'brain-db', okExitCodes: [0],
    };
    expect(buildArgv(CONFIG_SET, { key: 'search.mode', value: 'fast' }))
      .toEqual(['config', 'set', 'search.mode', 'fast']);
  });
});

describe('redactArgv', () => {
  test('replaces the value following a secret flag', () => {
    const argv = buildArgv(INIT, { nonInteractive: true, url: 'postgres://user:pw@h/db' });
    expect(redactArgv(INIT, argv))
      .toEqual(['init', '--non-interactive', '--url', '***REDACTED***']);
  });

  test('leaves non-secret values intact', () => {
    const argv = buildArgv(GRANT, { harness: 'claude-code', source: 'customers' });
    expect(redactArgv(GRANT, argv)).toEqual(argv);
  });
});
