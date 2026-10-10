import type { InputSchema } from '../args.ts';
import type { ToolDef } from '../registry.ts';

const seg = (v: unknown) => encodeURIComponent(String(v));
const OPTIONAL_SOURCE: InputSchema = {
  type: 'object',
  properties: { source: { type: 'string', description: 'One source id (Space). Omit for every company Space.', maxLength: 63 } },
  additionalProperties: false,
};

export const SCHEMA_TOOLS: ToolDef[] = [
  {
    name: 'schema_scaffold', minRole: 'admin', mutating: true,
    description: 'Create the active pack\'s folders (with READMEs) in a Space\'s git repo, create-only. Commits to the repo.',
    // `source` is optional on the route; it is required here so a bare call cannot touch every company Space.
    input: { ...OPTIONAL_SOURCE, required: ['source'] },
    route: (a) => ({ method: 'POST', path: '/api/schema/scaffold', body: { source: a.source } }),
  },
  {
    name: 'schema_pack_create', minRole: 'admin', mutating: true,
    description: 'Create a custom schema pack, by forking an existing pack (mode "fork": from, name) or from a PackDraft (mode "draft": draft). Does not activate it.',
    input: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fork', 'draft'] },
        from: { type: 'string', description: 'fork: the pack to copy.', maxLength: 64 },
        name: { type: 'string', description: 'fork: the new pack name.', maxLength: 64 },
        draft: { type: 'object', description: 'draft: a PackDraft (see the mobrain-schema-designer skill).' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    route: (a) => ({ method: 'POST', path: '/api/schema/packs', body: a }),
  },
  {
    name: 'schema_pack_mutate', minRole: 'admin', mutating: true,
    description: 'Apply a batch of mutations (add_type, update_type, add_link_type, …) to a custom pack, atomically. Bundled packs are read-only.',
    input: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 64 },
        mutations: { type: 'array', items: { type: 'object' }, description: 'gbrain ApplyMutationsRequest entries.' },
      },
      required: ['name', 'mutations'],
      additionalProperties: false,
    },
    route: (a) => ({ method: 'POST', path: `/api/schema/packs/${seg(a.name)}/mutations`, body: { mutations: a.mutations } }),
  },
  {
    name: 'schema_apply', minRole: 'admin', mutating: true,
    gated: {
      preview: async (args, read) => {
        const [current, validation, lint] = await Promise.all([
          read('GET', '/api/schema'),
          read('POST', '/api/schema/validate', { pack: args.pack }),
          // The safety gate lints STRICTER than the standalone `schema_lint`
          // tool: the console's own apply passes `withDb: true`, and the route
          // opts in only on `body?.withDb === true`. A preview that lints
          // without the DB check could clear a pack the real apply then refuses.
          read('POST', '/api/schema/lint', { pack: args.pack, withDb: true }),
        ]);
        const from = current.body?.active?.pack ?? null;
        return {
          summary: {
            from, to: args.pack,
            validation: validation.body, lint: lint.body,
            effect: 'Switches the brain-wide schema pack and scaffolds folders in company Spaces that inherit it. Run schema_preview and schema_sync afterwards to type existing pages.',
          },
          fingerprint: String(from),
        };
      },
    },
    description: 'Make a schema pack the brain\'s active pack.',
    input: { type: 'object', properties: { pack: { type: 'string', maxLength: 64 } }, required: ['pack'], additionalProperties: false },
    route: (a) => ({ method: 'POST', path: '/api/schema/apply', body: { pack: a.pack } }),
  },
  {
    name: 'schema_sync', minRole: 'admin', mutating: true,
    description: 'Rerun schema sync: give untyped pages a type from the active pack. Additive only: never reclassifies or deletes. Run schema_preview first.',
    input: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['brain', 'source'], description: '"brain" for every page, "source" for one Space.' },
        source: { type: 'string', description: 'Required when scope is "source".', maxLength: 63 },
      },
      required: ['scope'],
      additionalProperties: false,
    },
    // A `source`-scoped call that omits `source` sends `''`, never an omitted
    // key: the route's `sourceVisible` then refuses it, instead of reading the
    // missing fence as "whole brain" and applying the widest possible sync.
    route: (a) => ({ method: 'POST', path: '/api/schema/sync', body: a.scope === 'source' ? { source: a.source ?? '' } : {} }),
  },
];
