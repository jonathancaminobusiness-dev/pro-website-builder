import { z } from 'zod';
import { stageSchema } from './agent.js';

export const FindingSchema = z.object({ id: z.string(), severity: z.enum(['error', 'warning', 'info']), path: z.string(), message: z.string(), authority: z.string().optional(), suggestedPatch: z.unknown().optional() });
export const CritiqueReportSchema = z.object({ stage: stageSchema, findings: z.array(FindingSchema), score: z.number().min(0).max(1), summary: z.string() });
export type Finding = z.infer<typeof FindingSchema>;
export type CritiqueReport = z.infer<typeof CritiqueReportSchema>;
