/**
 * The subset of JSON Schema the control MCP's tool inputs use. Strict on
 * purpose: unknown keys are refused, so a tool can never be handed an identity
 * (`userId`, …) it does not declare — the confused-deputy rule (spec §7).
 */
export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
export type PropSchema = {
  type: JsonType | JsonType[];
  description?: string;
  enum?: readonly (string | number)[];
  items?: { type: JsonType };
  maxLength?: number;
};
export type InputSchema = {
  type: 'object';
  properties: Record<string, PropSchema>;
  required?: readonly string[];
  additionalProperties: false;
};

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function matches(t: JsonType, v: unknown): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
  }
}

export function validateArgs(
  schema: InputSchema, args: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; errors: string[] } {
  const value = args === undefined || args === null ? {} : args;
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['arguments must be an object'] };
  const a = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(a)) if (!own(schema.properties, key)) errors.push(`unknown argument: ${key}`);
  for (const key of schema.required ?? []) if (!own(a, key) || a[key] === undefined) errors.push(`missing argument: ${key}`);
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!own(a, key) || a[key] === undefined) continue;
    const v = a[key];
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    if (!types.some((t) => matches(t, v))) { errors.push(`${key} must be ${types.join(' or ')}`); continue; }
    if (prop.enum && !prop.enum.includes(v as string | number)) errors.push(`${key} must be one of ${prop.enum.join(', ')}`);
    if (typeof v === 'string' && prop.maxLength !== undefined && v.length > prop.maxLength) {
      errors.push(`${key} is longer than ${prop.maxLength}`);
    }
    if (Array.isArray(v) && prop.items) {
      v.forEach((item, i) => { if (!matches(prop.items!.type, item)) errors.push(`${key}[${i}] must be ${prop.items!.type}`); });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, args: a };
}
