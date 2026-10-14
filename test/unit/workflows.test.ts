import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// Actions minutes are a budget (docs/runbooks/ci.md): the org's Free plan shares
// 2,000 Linux minutes a month across every private repo, and on 2026-09-29 one
// PR fix loop burned 633 of them in a day. These checks keep the expensive
// shapes out of .github/workflows for good.
const DIR = join(import.meta.dir, '..', '..', '.github', 'workflows');

type Job = {
  'timeout-minutes'?: number;
  uses?: string;
  needs?: string | string[];
  with?: { gbrain_version?: string };
};
type Workflow = {
  on: string | string[] | Record<string, unknown>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, Job>;
};

function workflows(): Record<string, Workflow> {
  const out: Record<string, Workflow> = {};
  for (const name of readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n))) {
    out[name] = parse(readFileSync(join(DIR, name), 'utf8')) as Workflow;
  }
  return out;
}

function triggers(wf: Workflow): string[] {
  if (typeof wf.on === 'string') return [wf.on];
  if (Array.isArray(wf.on)) return wf.on;
  return Object.keys(wf.on);
}

describe('workflow budget rules', () => {
  test('only ci.yml runs on push or pull_request', () => {
    const automatic = Object.entries(workflows())
      .filter(([, wf]) => triggers(wf).some((t) => t === 'push' || t === 'pull_request'))
      .map(([name]) => name);
    expect(automatic).toEqual(['ci.yml']);
  });

  test('ci.yml cancels superseded runs and skips docs-only changes', () => {
    const ci = workflows()['ci.yml']!;
    expect(ci.concurrency?.['cancel-in-progress']).toBe(true);
    const on = ci.on as Record<string, { 'paths-ignore'?: string[] }>;
    for (const event of ['push', 'pull_request']) {
      expect(on[event]!['paths-ignore']).toContain('docs/**');
      expect(on[event]!['paths-ignore']).not.toContain('contracts/**');
    }
  });

  test('stack.yml runs only on demand', () => {
    expect(triggers(workflows()['stack.yml']!)).toEqual(['workflow_dispatch']);
  });

  test('the workflow set is exactly ci.yml and stack.yml', () => {
    expect(Object.keys(workflows()).sort()).toEqual(['ci.yml', 'stack.yml']);
  });

  test('no workflow runs on a schedule', () => {
    const scheduled = Object.entries(workflows())
      .filter(([, wf]) => triggers(wf).includes('schedule'))
      .map(([name]) => name);
    expect(scheduled).toEqual([]);
  });

  test('every job has a timeout (a reusable-workflow call inherits its callee\'s)', () => {
    const missing: string[] = [];
    for (const [name, wf] of Object.entries(workflows())) {
      for (const [id, job] of Object.entries(wf.jobs)) {
        if (job.uses === undefined && job['timeout-minutes'] === undefined) missing.push(`${name}:${id}`);
      }
    }
    expect(missing).toEqual([]);
  });

});
