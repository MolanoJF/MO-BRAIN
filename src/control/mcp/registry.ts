/**
 * The control MCP's tools. Each is declarative: a name, an input schema, the
 * min role (== the wrapped route's guard; Task 8 asserts it) and the route it
 * runs. No tool carries its own policy.
 */
import type { Role } from '../rbac.ts';
import type { InputSchema } from './args.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type RouteRequest = { method: HttpMethod; path: string; body?: unknown };
export type Reader = (method: HttpMethod, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
export type GatePreview = (args: Record<string, unknown>, read: Reader) => Promise<{ summary: unknown; fingerprint?: string }>;

export type ToolDef = {
  name: string;
  description: string;
  minRole: Role;
  mutating: boolean;
  /** D6: called without `confirm`, returns a preview and a confirm token instead of acting. */
  gated?: { preview?: GatePreview };
  input: InputSchema;
  route: (args: Record<string, unknown>) => RouteRequest;
};

export type ToolListing = {
  name: string;
  description: string;
  inputSchema: InputSchema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
};

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
};

import { READ_TOOLS } from './tools/read.ts';
import { SOURCE_TOOLS } from './tools/sources.ts';
import { PEOPLE_TOOLS } from './tools/people.ts';

export const TOOLS: readonly ToolDef[] = [...READ_TOOLS, ...SOURCE_TOOLS, ...PEOPLE_TOOLS];
