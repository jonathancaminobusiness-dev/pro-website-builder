import { z } from 'zod';
import { designIRSchema } from './ir.js';
import { identitySpecSchema } from './identity.js';

export const stageSchema = z.enum(['identity', 'prototype', 'finalization']);
export const taskRoleSchema = z.enum(['director', 'composer', 'compiler', 'critic']);
export const taskStateSchema = z.enum(['queued', 'running', 'cancel_requested', 'cancelled', 'succeeded', 'failed', 'needs_review']);

export const agentTaskSchema = z.object({
  id: z.string(), stage: stageSchema, role: taskRoleSchema, state: taskStateSchema, baseVersionId: z.string(), inputDigest: z.string(), promptVersion: z.string(), modelAlias: z.string(), deadlineMs: z.number().positive(), allowedPaths: z.array(z.string()), brief: z.string(),
});

export const patchOperationSchema = z.object({ op: z.enum(['add', 'replace', 'remove', 'test']), path: z.string().regex(/^\//), value: z.unknown().optional() });
export const patchSchema = z.object({
  op: z.enum(['proposal', 'rejection']).default('proposal'),
  operations: z.array(patchOperationSchema).min(1),
  baseVersionId: z.string(), touchedPaths: z.array(z.string()), rationale: z.string().min(1), confidence: z.number().min(0).max(1),
  stage: stageSchema, role: taskRoleSchema, idempotencyKey: z.string().optional(),
});

export const agentResultSchema = z.object({
  taskId: z.string(), status: z.enum(['succeeded', 'failed', 'needs_review']), summary: z.string(), proposal: patchSchema.optional(), output: z.union([identitySpecSchema, designIRSchema]).optional(), errorCode: z.string().optional(),
});

export type AgentTask = z.infer<typeof agentTaskSchema>;
export type Patch = z.infer<typeof patchSchema>;
export type AgentResult = z.infer<typeof agentResultSchema>;
export const AgentTaskSchema = agentTaskSchema;
export const PatchSchema = patchSchema;
export const AgentResultSchema = agentResultSchema;
