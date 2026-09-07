import { z } from 'zod';
import { stageSchema } from './agent.js';

export const approvalSchema = z.object({
  id: z.string(), stage: stageSchema, approverRole: z.literal('captain'), versionId: z.string(), versionHash: z.string(), decision: z.enum(['approved', 'rejected']), rationale: z.string(), createdAt: z.string(),
});
export type Approval = z.infer<typeof approvalSchema>;
