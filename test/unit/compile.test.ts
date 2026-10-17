// test/unit/compile.test.ts
import { describe, expect, test } from 'bun:test';
import {
  ADMIN_AGENT_PROFILE, PROFILE_READER, PROFILE_WRITER, compileUserClients, companyWriterSpec,
  instanceSpec, narrowest,
} from '../../src/server/people/compile.ts';
import type { Grant, Source, User } from '../../src/server/types.ts';

const u = (id: string, role: User['role'], status: User['status'] = 'active'): User =>
  ({ id, email: `${id}@x.io`, name: null, role, status, createdAt: new Date() });
const priv = (id: string, owner: string): Source => ({ id, kind: 'private', ownerUserId: owner, name: id, status: 'active' });
const comp = (id: string, status: Source['status'] = 'active'): Source => ({ id, kind: 'company', ownerUserId: null, name: id, status });
const g = (userId: string, sourceId: string, agentReads = true): Grant => ({ userId, sourceId, agentReads });

const sources = [priv('p-own', 'own'), priv('p-mem', 'mem'), comp('c-a'), comp('c-b'), comp('c-old', 'archived')];

describe('compileUserClients', () => {
  test('owner: writes own private, reads every active company source, never another private', () => {
    const specs = compileUserClients(u('own', 'owner'), { sources, grants: [] });
    expect(specs.map((s) => [s.purpose, s.profile, s.writeSource, s.readSources])).toEqual([
      ['agent', ADMIN_AGENT_PROFILE, 'p-own', ['c-a', 'c-b']],
      ['ui', PROFILE_READER, 'p-own', ['c-a', 'c-b']],
    ]);
  });

  test('member: agent reads only granted sources with agentReads; ui reads every granted source', () => {
    const specs = compileUserClients(u('mem', 'member'), { sources, grants: [g('mem', 'c-a'), g('mem', 'c-b', false), g('mem', 'c-old')] });
    expect(specs.map((s) => [s.purpose, s.profile, s.writeSource, s.readSources])).toEqual([
      ['agent', PROFILE_WRITER, 'p-mem', ['c-a']],
      ['ui', PROFILE_READER, 'p-mem', ['c-a', 'c-b']],
    ]);
  });

  test('viewer: read-only clients over granted sources, none without grants', () => {
    expect(compileUserClients(u('v', 'viewer'), { sources, grants: [] })).toEqual([]);
    const specs = compileUserClients(u('v', 'viewer'), { sources, grants: [g('v', 'c-b'), g('v', 'c-a', false)] });
    expect(specs.map((s) => [s.purpose, s.profile, s.writeSource, s.readSources])).toEqual([
      ['agent', PROFILE_READER, 'c-b', []],
      ['ui', PROFILE_READER, 'c-a', ['c-b']],
    ]);
  });

  test('anyone not active gets nothing', () => {
    for (const status of ['invited', 'offboarding', 'disabled'] as const) {
      expect(compileUserClients(u('mem', 'member', status), { sources, grants: [g('mem', 'c-a')] })).toEqual([]);
    }
  });

  test('a member without a private source gets nothing', () => {
    expect(compileUserClients(u('zz', 'member'), { sources, grants: [g('zz', 'c-a')] })).toEqual([]);
  });

  test('names are deterministic', () => {
    const [agent] = compileUserClients(u('0123456789ab-cdef', 'owner'), { sources: [priv('p-x', '0123456789ab-cdef')], grants: [] });
    expect(agent!.name).toBe('mb-agent-01234567');
  });
});

describe('instance and company writer', () => {
  test('instance reads company sources from the owner private source', () => {
    const s = instanceSpec(u('own', 'owner'), { sources, grants: [] });
    expect(s.profile).toBe(ADMIN_AGENT_PROFILE);
    expect([s.purpose, s.name, s.writeSource, s.readSources]).toEqual(['instance', 'mb-instance', 'p-own', ['c-a', 'c-b']]);
  });
  test('company writer writes one company source', () => {
    const s = companyWriterSpec(u('own', 'owner'), 'c-a');
    expect([s.purpose, s.profile, s.writeSource, s.readSources]).toEqual(['company_writer', PROFILE_WRITER, 'c-a', []]);
  });
});

describe('narrowest', () => {
  const base = compileUserClients(u('mem', 'member'), { sources, grants: [g('mem', 'c-a'), g('mem', 'c-b')] })[1]!;
  test('intersects reads', () => {
    const after = { ...base, readSources: ['c-b'] };
    expect(narrowest(base, after)!.readSources).toEqual(['c-b']);
    const wider = { ...base, readSources: ['c-a', 'c-b', 'c-c'] };
    expect(narrowest(base, wider)!.readSources).toEqual(['c-a', 'c-b']);
  });
  test('null when either side is missing or the write source changes', () => {
    expect(narrowest(base, undefined)).toBeNull();
    expect(narrowest(undefined, base)).toBeNull();
    expect(narrowest(base, { ...base, writeSource: 'c-a' })).toBeNull();
  });
  test('takes the less privileged profile', () => {
    expect(narrowest({ ...base, profile: PROFILE_WRITER }, { ...base, profile: PROFILE_READER })!.profile).toBe(PROFILE_READER);
  });
});
