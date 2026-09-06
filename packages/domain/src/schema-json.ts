import { zodToJsonSchema } from 'zod-to-json-schema';
import { agentResultSchema, agentTaskSchema, patchSchema } from './agent.js';
import { approvalSchema } from './approval.js';
import { designIRSchema } from './ir.js';
import { identitySpecSchema } from './identity.js';

export const schemaJson = {
  AgentTask: zodToJsonSchema(agentTaskSchema, 'AgentTask'),
  AgentResult: zodToJsonSchema(agentResultSchema, 'AgentResult'),
  Patch: zodToJsonSchema(patchSchema, 'Patch'),
  Approval: zodToJsonSchema(approvalSchema, 'Approval'),
  IdentitySpec: zodToJsonSchema(identitySpecSchema, 'IdentitySpec'),
  DesignIR: zodToJsonSchema(designIRSchema, 'DesignIR'),
};
