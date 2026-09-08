import { z } from 'zod';
import { hashJson, inlinedJsonSchema } from '@pwb/domain';

export const critiqueDimensionSchema = z.enum(['narrative', 'responsiveness', 'a11y-interaction', 'coherence']);
export const findingSeveritySchema = z.enum(['blocker', 'major', 'minor', 'info']);

/** The rubric is absolute and behavioural: 0–4 per criterion, and 3 is the minimum a gate accepts. */
export const MIN_RUBRIC_SCORE = 3;

/**
 * The prop names a critic may retune. It mirrors `visualPropsSchema` in the domain and a test keeps
 * the two in step; the enum exists so the JSON Schema handed to a model closes the vocabulary.
 */
export const patchablePropSchema = z.enum([
  'color', 'background', 'padding', 'paddingBlock', 'paddingInline', 'gap', 'radius', 'font',
  'fontSize', 'fontWeight', 'shadow', 'motion', 'width', 'height', 'margin', 'maxWidth',
]);

export const tokenReferenceSchema = z.string().regex(/^\{[^{}]+\}$/, 'A token reference reads as {group.name}.');

export const evidenceRefSchema = z.object({
  route: z.string().min(1),
  viewport: z.number().int().positive(),
  state: z.string().min(1),
  colorScheme: z.enum(['light', 'dark']),
  reducedMotion: z.boolean(),
  nodeIds: z.array(z.string().min(1)).min(1),
  box: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }).strict().optional(),
}).strict();

/** The closed allowlist of repairs. A critic never writes HTML and never proposes anything else. */
export const proposedPatchSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('set_token'), nodeId: z.string().min(1), prop: patchablePropSchema, token: tokenReferenceSchema }).strict(),
  z.object({ operation: z.literal('set_constraint'), nodeId: z.string().min(1), minWidth: tokenReferenceSchema, prop: patchablePropSchema, token: tokenReferenceSchema }).strict(),
  z.object({ operation: z.literal('set_crop'), assetId: z.string().min(1), focalX: z.number().min(0).max(1), focalY: z.number().min(0).max(1), aspect: z.string().regex(/^\d+:\d+$/) }).strict(),
  z.object({ operation: z.literal('replace_copy'), nodeId: z.string().min(1), text: z.string().min(1).max(400) }).strict(),
  z.object({ operation: z.literal('reorder_node'), nodeId: z.string().min(1), slot: z.string().min(1), order: z.array(z.string().min(1)).min(2) }).strict(),
]);

export const findingSchema = z.object({
  id: z.string().min(1),
  dimension: critiqueDimensionSchema,
  severity: findingSeveritySchema,
  evidence: evidenceRefSchema,
  observation: z.string().min(1),
  why: z.string().min(1),
  confidence: z.number().min(0).max(1),
  patch: proposedPatchSchema.optional(),
  checks: z.array(z.string()),
  abstain: z.boolean(),
}).strict().superRefine((finding, ctx) => {
  if (finding.abstain && finding.patch) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['patch'], message: `Finding ${finding.id} abstains, so it must not carry a repair.` });
});

export const rubricScoreSchema = z.object({
  criterion: z.string().min(1), score: z.number().int().min(0).max(4), evidence: z.string().min(1),
}).strict();

/**
 * The critic's answer, decomposed the way Criticmate separates the work: what is seen, what it means,
 * and only then what is wrong. Every observation is located by node id and carries the smallest repair.
 */
export const critiqueReportSchema = z.object({
  schemaVersion: z.literal('1'),
  stage: z.literal('prototype'),
  dimension: critiqueDimensionSchema,
  criticSessionId: z.string().min(1),
  perception: z.object({
    summary: z.string().min(1),
    regions: z.array(z.object({ nodeId: z.string().min(1), role: z.string().min(1), note: z.string().min(1) }).strict()),
  }).strict(),
  comprehension: z.object({
    hierarchy: z.string().min(1), intent: z.string().min(1), brandAlignment: z.string().min(1),
  }).strict(),
  projection: z.object({
    verdict: z.enum(['pass', 'revise', 'uncertain']),
    rubric: z.array(rubricScoreSchema).min(1),
    findings: z.array(findingSchema).max(12),
  }).strict(),
}).strict().superRefine((report, ctx) => {
  const { verdict, rubric, findings } = report.projection;
  if (findings.some((finding) => finding.dimension !== report.dimension)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projection', 'findings'], message: `A ${report.dimension} critic may only report findings of its own dimension.` });
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projection', 'findings'], message: 'Finding ids must be unique inside a report.' });
  if (verdict === 'pass') {
    const below = rubric.filter((entry) => entry.score < MIN_RUBRIC_SCORE);
    if (below.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projection', 'verdict'], message: `A pass needs at least ${MIN_RUBRIC_SCORE} on every criterion; ${below.map((entry) => entry.criterion).join(', ')} scored lower.` });
    if (findings.some((finding) => finding.severity === 'blocker' || finding.severity === 'major')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projection', 'verdict'], message: 'A pass cannot carry a blocking or major finding.' });
  }
  if (verdict === 'revise' && findings.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projection', 'findings'], message: 'A revise verdict must say what to revise.' });
});

export type CritiqueDimension = z.infer<typeof critiqueDimensionSchema>;
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type ProposedPatch = z.infer<typeof proposedPatchSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type RubricScore = z.infer<typeof rubricScoreSchema>;
export type CritiqueReport = z.infer<typeof critiqueReportSchema>;

/**
 * The causal identity of a problem: the same defect on the same nodes with the same proposed repair
 * keeps its hash across cycles, which is how the loop notices it is going in circles.
 */
export function issueHash(finding: Finding): string {
  const patch = finding.patch;
  return hashJson([
    finding.dimension, finding.severity, [...finding.evidence.nodeIds].sort(),
    patch ? [patch.operation, 'nodeId' in patch ? patch.nodeId : patch.assetId, 'prop' in patch ? patch.prop : '', 'minWidth' in patch ? patch.minWidth : ''] : ['none'],
  ]);
}

/** The mean rubric score of a set of reports, used only to tell improvement from judge noise. */
export function rubricAverage(reports: CritiqueReport[]): number {
  const scores = reports.flatMap((report) => report.projection.rubric.map((entry) => entry.score));
  return scores.length === 0 ? 0 : scores.reduce((total, score) => total + score, 0) / scores.length;
}

export const critiqueSchemaJson = {
  CritiqueReport: inlinedJsonSchema(critiqueReportSchema),
  Finding: inlinedJsonSchema(findingSchema),
};
