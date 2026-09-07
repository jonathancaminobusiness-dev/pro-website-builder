import { zodToJsonSchema } from 'zod-to-json-schema';
import { agentResultSchema } from './agent.js';
import { assetsSchema, pagesSchema, reviewRecordSchema } from './ir.js';
import { identitySpecSchema } from './identity.js';

function withoutUnionTypes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutUnionTypes);
  if (!node || typeof node !== 'object') return node;
  const entry = Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, value]) => [key, withoutUnionTypes(value)]));
  if (!Array.isArray(entry.type)) return entry;
  const { type, ...rest } = entry;
  return { ...rest, anyOf: (type as string[]).map((item) => ({ type: item })) };
}

export const schemaJson = {
  AgentResult: withoutUnionTypes(zodToJsonSchema(agentResultSchema)),
};

export const documentPathSchemas: Record<string, unknown> = {
  '/identity': withoutUnionTypes(zodToJsonSchema(identitySpecSchema)),
  '/pages': withoutUnionTypes(zodToJsonSchema(pagesSchema)),
  '/assets': withoutUnionTypes(zodToJsonSchema(assetsSchema)),
  '/reviewRecord': withoutUnionTypes(zodToJsonSchema(reviewRecordSchema)),
};
