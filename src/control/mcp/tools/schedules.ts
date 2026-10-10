import type { InputSchema, PropSchema } from '../args.ts';
import type { ToolDef } from '../registry.ts';
import { canonical } from '../confirm.ts';
import { CONNECTION_INPUT } from './read.ts';

const seg = (v: unknown) => encodeURIComponent(String(v));

/** The fields `POST/PATCH /schedules` read (src/control/routes/schedules.ts). The route validates values. */
const SCHEDULE_FIELDS: Record<string, PropSchema> = {
  name: { type: 'string', description: 'Lowercase job name; becomes reports/<name>/.', maxLength: 64 },
  connectionId: { type: 'string', description: 'The Connection it runs as. A member may use only their own.', maxLength: 64 },
  preset: { type: 'string', description: 'A preset id from the console\'s schedule presets.', maxLength: 64 },
  jobType: { type: 'string', enum: ['gbrain_command', 'agent_prompt'] },
  operation: { type: 'string', description: 'gbrain_command: the operation, e.g. sync.', maxLength: 64 },
  params: { type: 'object', description: 'gbrain_command: operation parameters.' },
  kind: { type: 'string', enum: ['interval', 'calendar'] },
  intervalSeconds: { type: 'integer' },
  calendarHour: { type: 'integer' },
  calendarMinute: { type: 'integer' },
  calendarDaysOfWeek: { type: 'array', items: { type: 'integer' } },
  timezone: { type: 'string', maxLength: 64 },
  enabled: { type: 'boolean' },
  timeoutSeconds: { type: 'integer' },
  misfireGraceSeconds: { type: 'integer' },
  notifies: { type: ['boolean', 'object', 'array'] },
  agentPrompt: { type: 'string', maxLength: 20_000 },
  agentModel: { type: 'string', maxLength: 64 },
  agentMaxTokens: { type: 'integer' },
  agentBudgetUsd: { type: ['number', 'string'] },
};

const CREATE: InputSchema = { type: 'object', properties: SCHEDULE_FIELDS, required: ['name', 'connectionId'], additionalProperties: false };
const UPDATE: InputSchema = {
  type: 'object',
  properties: { id: { type: 'string', maxLength: 64 }, ...SCHEDULE_FIELDS },
  required: ['id'],
  additionalProperties: false,
};

export const SCHEDULE_TOOLS: ToolDef[] = [
  {
    name: 'schedule_create', minRole: 'member', mutating: true, input: CREATE,
    description: 'Create a schedule: a gbrain command or an agent prompt that runs on an interval or calendar, as one of your Connections.',
    route: (a) => ({ method: 'POST', path: '/api/schedules', body: a }),
  },
  {
    name: 'schedule_update', minRole: 'member', mutating: true, input: UPDATE,
    description: 'Change a schedule you own (or any company schedule, as an admin): timing, enabled, parameters.',
    route: (a) => {
      const { id, ...body } = a;
      return { method: 'PATCH', path: `/api/schedules/${seg(id)}`, body };
    },
  },
  {
    name: 'schedule_run_now', minRole: 'member', mutating: true,
    input: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'], additionalProperties: false },
    description: 'Queue one manual run of a schedule now. Agent-prompt runs spend model budget.',
    route: (a) => ({ method: 'POST', path: `/api/schedules/${seg(a.id)}/run-now`, body: {} }),
  },
  {
    name: 'connection_create', minRole: 'admin', mutating: true, input: CONNECTION_INPUT,
    gated: {
      preview: async (args, read) => {
        const p = await read('POST', '/api/connections/preview', args);
        return {
          summary: { status: p.status, grant: p.body },
          // D6: bind what the human was shown. The compiled grant is derived from
          // the target membership's role, its Spaces and the Connection's fences,
          // so a Connection state that changed between the preview and the
          // confirm previews differently and the token stops matching. The ops
          // dry-run output (`serverPreview`) is deliberately NOT part of this:
          // a fingerprint that varied per call would refuse every confirm.
          fingerprint: canonical([p.status, p.body?.compiled ?? p.body ?? null]),
        };
      },
    },
    description: 'Create a pending company-zone agent Connection for a member. The member claims it to receive the credential; nothing secret is returned here.',
    route: (a) => ({ method: 'POST', path: '/api/connections', body: a }),
  },
];
