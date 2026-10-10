import type { ToolDef } from '../registry.ts';

export const PEOPLE_TOOLS: ToolDef[] = [
  {
    name: 'member_invite', minRole: 'admin', mutating: true,
    gated: {
      preview: async (args, read) => {
        const org = await read('GET', '/api/org');
        if (org.body?.capabilities?.invite === false) return { summary: null, blocked: { status: 403, body: { error: 'company_mode_required' } } };
        return {
        summary: { invite: args.email, role: args.role, effect: 'Creates a placeholder account and membership; the person sets a password from a claim link an admin sends.' },
        };
      },
    },
    description: 'Invite a person to this organization with a role. Company mode only. Does not send email and never returns a claim link.',
    input: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Their email address.', maxLength: 320 },
        role: { type: 'string', enum: ['admin', 'member', 'viewer'] },
      },
      required: ['email', 'role'],
      additionalProperties: false,
    },
    route: (a) => ({ method: 'POST', path: '/api/members', body: { email: a.email, role: a.role } }),
  },
  {
    name: 'org_set_mode', minRole: 'owner', mutating: true,
    gated: {
      preview: async (args, read) => {
        const org = await read('GET', '/api/org');
        const from = String(org.body?.brainMode ?? 'unknown');
        return {
          summary: {
            from, to: args.mode,
            effect: args.mode === 'personal'
              ? 'Personal mode: no invites, shared sources or grants. Refused while other members or open invites exist.'
              : 'Company mode: enables invites, shared company Spaces and grants.',
          },
          fingerprint: from,
        };
      },
    },
    description: 'Switch the brain between personal and company mode. Owner only.',
    input: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['personal', 'company'] },
        name: { type: 'string', description: 'Optionally rename the organization at the same time.', maxLength: 200 },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    route: (a) => ({ method: 'PATCH', path: '/api/org/mode', body: a.name === undefined ? { mode: a.mode } : { mode: a.mode, name: a.name } }),
  },
];
