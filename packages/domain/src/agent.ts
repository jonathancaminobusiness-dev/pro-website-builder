import { z } from 'zod';
import { hashJson } from './tokens.js';

export const stageSchema = z.enum(['identity', 'prototype', 'finalization']);
export const taskRoleSchema = z.enum(['director', 'composer', 'compiler']);
export const taskStateSchema = z.enum(['queued', 'running', 'cancel_requested', 'cancelled', 'succeeded', 'failed', 'needs_review']);
export const taskLaneSchema = z.enum(['claude', 'raster']);

export const agentTaskSchema = z.object({
  id: z.string(), attempt: z.number().int().positive(), stage: stageSchema, role: taskRoleSchema, state: taskStateSchema, lane: taskLaneSchema.default('claude'), baseVersionId: z.string(), inputDigest: z.string(), promptVersion: z.string(), modelAlias: z.string(), deadlineMs: z.number().positive(), allowedPaths: z.array(z.string()), brief: z.string(),
  documentSlice: z.record(z.unknown()).refine((slice) => '/identity' in slice, 'A task slice must carry the identity contract the worker may read.'),
});

export const patchOperationSchema = z.object({ op: z.enum(['add', 'replace', 'remove', 'test']), path: z.string().regex(/^\//), value: z.unknown().optional() });
export const patchSchema = z.object({
  op: z.enum(['proposal', 'rejection']).default('proposal'),
  operations: z.array(patchOperationSchema).min(1),
  baseVersionId: z.string(), touchedPaths: z.array(z.string()), rationale: z.string().min(1), confidence: z.number().min(0).max(1),
  stage: stageSchema, role: taskRoleSchema, idempotencyKey: z.string().optional(),
});

export const agentResultSchema = z.object({
  taskId: z.string(), status: z.enum(['succeeded', 'failed', 'needs_review']), summary: z.string(), proposal: patchSchema.optional(), errorCode: z.string().optional(),
});

export function idempotencyKey(input: Pick<AgentTask, 'stage' | 'role' | 'baseVersionId' | 'inputDigest' | 'promptVersion' | 'modelAlias'>): string {
  return hashJson([input.stage, input.role, input.baseVersionId, input.inputDigest, input.promptVersion, input.modelAlias]);
}

export type AgentTask = z.infer<typeof agentTaskSchema>;
export type Patch = z.infer<typeof patchSchema>;
export type AgentResult = z.infer<typeof agentResultSchema>;
