import type { InputSchema } from '../args.ts';
import type { ToolDef } from '../registry.ts';

export const NO_ARGS: InputSchema = { type: 'object', properties: {}, additionalProperties: false };

const seg = (v: unknown) => encodeURIComponent(String(v));
const one = (key: string, description: string, maxLength = 200): InputSchema => ({
  type: 'object', properties: { [key]: { type: 'string', description, maxLength } }, required: [key], additionalProperties: false,
});
const PACK = one('pack', 'Schema pack name', 64);
const OPTIONAL_SOURCE: InputSchema = {
  type: 'object',
  properties: { source: { type: 'string', description: 'Limit to one source id (Space). Omit for the whole brain.', maxLength: 63 } },
  additionalProperties: false,
};

export const CONNECTION_INPUT: InputSchema = {
  type: 'object',
  properties: {
    membershipId: { type: 'string', description: 'The member the Connection is for (from member_list).', maxLength: 64 },
    writeSpaceId: { type: 'string', description: 'The one company Space it writes to (from space_list).', maxLength: 64 },
    readSpaceIds: { type: 'array', items: { type: 'string' }, description: 'Company Spaces it may read.' },
    harness: { type: 'string', description: 'Harness id, e.g. claude-code, codex, generic.', maxLength: 40 },
    tokenTtl: { type: 'integer', description: 'Access-token lifetime in seconds.' },
    budgetUsdPerDay: { type: 'number', description: 'Daily spend cap in USD.' },
    boundSlugPrefixes: { type: 'array', items: { type: 'string' }, description: 'Restrict writes to these slug prefixes.' },
  },
  required: ['membershipId', 'writeSpaceId', 'harness'],
  additionalProperties: false,
};

export const READ_TOOLS: ToolDef[] = [
  {
    name: 'org_get', minRole: 'viewer', mutating: false, input: NO_ARGS,
    description: 'This organization: name, brain mode (personal or company), what the mode allows, member count, and your role.',
    route: () => ({ method: 'GET', path: '/api/org' }),
  },
  {
    name: 'space_list', minRole: 'viewer', mutating: false, input: NO_ARGS,
    description: 'Spaces you can see: your own personal Space and company Spaces you are granted.',
    route: () => ({ method: 'GET', path: '/api/spaces' }),
  },
  {
    name: 'source_list', minRole: 'viewer', mutating: false, input: NO_ARGS,
    description: 'Every gbrain source in this brain with its Space, schema pack, sync status and git remote.',
    route: () => ({ method: 'GET', path: '/api/sources' }),
  },
  {
    name: 'member_list', minRole: 'admin', mutating: false, input: NO_ARGS,
    description: 'Members of this organization with their roles and membership ids.',
    route: () => ({ method: 'GET', path: '/api/members' }),
  },
  {
    name: 'grant_list', minRole: 'admin', mutating: false, input: NO_ARGS,
    description: 'Company Space grants: which membership can read or write which Space.',
    route: () => ({ method: 'GET', path: '/api/grants' }),
  },
  {
    name: 'schema_get', minRole: 'admin', mutating: false, input: NO_ARGS,
    description: 'The schema pack this brain stored, the pack gbrain actually resolves (and from which tier), and whether they diverged.',
    route: () => ({ method: 'GET', path: '/api/schema' }),
  },
  {
    name: 'schema_pack_list', minRole: 'viewer', mutating: false, input: NO_ARGS,
    description: 'Schema packs available: bundled and installed.',
    route: () => ({ method: 'GET', path: '/api/schema/packs' }),
  },
  {
    name: 'schema_pack_show', minRole: 'admin', mutating: false, input: one('name', 'Schema pack name', 64),
    description: 'One schema pack in full: page types, folders and link verbs.',
    route: (a) => ({ method: 'GET', path: `/api/schema/packs/${seg(a.name)}` }),
  },
  {
    name: 'schema_validate', minRole: 'admin', mutating: false, input: PACK,
    description: 'Validate a schema pack manifest. Changes nothing.',
    route: (a) => ({ method: 'POST', path: '/api/schema/validate', body: { pack: a.pack } }),
  },
  {
    name: 'schema_lint', minRole: 'admin', mutating: false,
    input: { type: 'object', properties: { pack: { type: 'string', maxLength: 64, description: 'Pack to lint; omit for the active pack.' } }, additionalProperties: false },
    description: 'Run gbrain\'s schema lint on a pack. Changes nothing.',
    route: (a) => ({ method: 'POST', path: '/api/schema/lint', body: a.pack === undefined ? {} : { pack: a.pack } }),
  },
  {
    name: 'schema_preview', minRole: 'admin', mutating: false, input: OPTIONAL_SOURCE,
    description: 'Dry run of schema sync: how many pages would get a type, with samples. Changes nothing. Run before schema_sync.',
    route: (a) => ({ method: 'POST', path: '/api/schema/preview', body: a.source === undefined ? {} : { source: a.source } }),
  },
  {
    name: 'schedule_list', minRole: 'viewer', mutating: false, input: NO_ARGS,
    description: 'Schedules you can see: company ones and your own personal ones.',
    route: () => ({ method: 'GET', path: '/api/schedules' }),
  },
  {
    name: 'schedule_get', minRole: 'viewer', mutating: false, input: one('id', 'Schedule id', 64),
    description: 'One schedule in full.',
    route: (a) => ({ method: 'GET', path: `/api/schedules/${seg(a.id)}` }),
  },
  {
    name: 'run_list', minRole: 'viewer', mutating: false,
    input: { type: 'object', properties: { limit: { type: 'integer', description: 'Max rows, 1-200 (default 50).' } }, additionalProperties: false },
    description: 'Recent agent runs you can see, newest first, with state and cost.',
    route: (a) => ({ method: 'GET', path: `/api/runs${a.limit === undefined ? '' : `?limit=${Number(a.limit)}`}` }),
  },
  {
    name: 'run_get', minRole: 'viewer', mutating: false, input: one('id', 'Run id', 64),
    description: 'One agent run with its events and outcome.',
    route: (a) => ({ method: 'GET', path: `/api/runs/${seg(a.id)}` }),
  },
  {
    name: 'connection_list', minRole: 'admin', mutating: false, input: NO_ARGS,
    description: 'Agent Connections in the company zone, with state, harness and scope. Never includes secrets.',
    route: () => ({ method: 'GET', path: '/api/connections' }),
  },
  {
    name: 'connection_preview', minRole: 'admin', mutating: false, input: CONNECTION_INPUT,
    description: 'Preview the gbrain grant a new Connection would get. Changes nothing.',
    route: (a) => ({ method: 'POST', path: '/api/connections/preview', body: a }),
  },
];
