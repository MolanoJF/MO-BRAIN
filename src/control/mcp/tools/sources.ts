import type { ToolDef } from '../registry.ts';

const seg = (v: unknown) => encodeURIComponent(String(v));

export const SOURCE_TOOLS: ToolDef[] = [
  {
    name: 'source_create', minRole: 'admin', mutating: true,
    description: 'Create a Space: a new gbrain source with its git repo and folders. Everyone granted read on it can retrieve everything in it.',
    input: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Lowercase id: letters, digits, hyphens; starts with a letter or digit; max 63.', maxLength: 63 },
        name: { type: 'string', description: 'Display name.', maxLength: 200 },
        description: { type: 'string', description: 'What belongs in it.', maxLength: 2000 },
      },
      required: ['sourceId', 'name'],
      additionalProperties: false,
    },
    route: (a) => ({ method: 'POST', path: '/api/sources', body: { sourceId: a.sourceId, name: a.name, description: a.description } }),
  },
  {
    name: 'source_rename', minRole: 'viewer', mutating: true,
    description: 'Change a source\'s display name. The id never changes.',
    input: {
      type: 'object',
      properties: { sourceId: { type: 'string', maxLength: 63 }, name: { type: 'string', maxLength: 200 } },
      required: ['sourceId', 'name'],
      additionalProperties: false,
    },
    route: (a) => ({ method: 'PATCH', path: `/api/sources/${seg(a.sourceId)}`, body: { name: a.name } }),
  },
  {
    name: 'grant_set', minRole: 'admin', mutating: true,
    description: 'Give a member read or write access to a company Space (creates or changes the grant). Company mode only. Cannot remove access.',
    input: {
      type: 'object',
      properties: {
        membershipId: { type: 'string', description: 'From member_list.', maxLength: 64 },
        spaceId: { type: 'string', description: 'A company Space id, from space_list.', maxLength: 64 },
        access: { type: 'string', enum: ['read', 'write'] },
      },
      required: ['membershipId', 'spaceId', 'access'],
      additionalProperties: false,
    },
    route: (a) => ({ method: 'PUT', path: '/api/grants', body: { membershipId: a.membershipId, spaceId: a.spaceId, access: a.access } }),
  },
];
