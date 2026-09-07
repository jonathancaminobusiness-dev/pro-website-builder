import { zodToJsonSchema } from 'zod-to-json-schema';
import { agentResultSchema, agentTaskSchema, patchSchema } from './agent.js';
import { approvalSchema } from './approval.js';
import { designIRSchema } from './ir.js';
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
  AgentTask: withoutUnionTypes(zodToJsonSchema(agentTaskSchema)),
  AgentResult: withoutUnionTypes(zodToJsonSchema(agentResultSchema)),
  Patch: withoutUnionTypes(zodToJsonSchema(patchSchema)),
  Approval: withoutUnionTypes(zodToJsonSchema(approvalSchema)),
  IdentitySpec: withoutUnionTypes(zodToJsonSchema(identitySpecSchema)),
  DesignIR: withoutUnionTypes(zodToJsonSchema(designIRSchema)),
};
