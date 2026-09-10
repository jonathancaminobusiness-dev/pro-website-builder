import { divergenceAxisSchema, evidenceSchema } from '@pwb/domain';
import { z } from 'zod';
import type { IdentityAxisBriefId } from './axes.js';

export const IDENTITY_PROMPT_VERSION = 'identity-v2';

/**
 * The brief curator extracts before it creates: facts, unknowns and explicit
 * assumptions stay separated, and every later choice cites one of these
 * evidence ids. A missing fact becomes an assumption, never a visual prior.
 */
export const briefSpecSchema = z.object({
  audience: z.string().min(1),
  job: z.string().min(1),
  promise: z.string().min(1),
  proof: z.array(z.string().min(1)).min(1),
  exclusions: z.array(z.string().min(1)).min(1),
  evidence: z.array(evidenceSchema).min(3),
  unknowns: z.array(z.string().min(1)).default([]),
  assumptions: z.array(z.object({ id: z.string().min(1), statement: z.string().min(1), risk: z.enum(['low', 'medium', 'high']) })).default([]),
  forbiddenDefaults: z.object({
    fonts: z.array(z.string().min(1)).min(1),
    palettes: z.array(z.string().min(1)).min(1),
    motifs: z.array(z.string().min(1)).min(1),
  }),
}).strict().superRefine((brief, ctx) => {
  const ids = brief.evidence.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'Evidence ids must be unique.' });
});
export type BriefSpec = z.infer<typeof briefSpecSchema>;

export const critiqueDimensionSchema = z.enum(['brand-fit', 'divergence', 'system-accessibility']);
export type CritiqueDimension = z.infer<typeof critiqueDimensionSchema>;

/** The rubric is absolute and per dimension, so a strong colour cannot pay for an unreadable system. */
export const RUBRIC_MINIMUM = 3;

export const critiqueFindingSchema = z.object({
  id: z.string().min(1),
  dimension: critiqueDimensionSchema,
  severity: z.enum(['veto', 'error', 'warning', 'info']),
  /** Where the finding lives in the document, as a JSON pointer into the DesignIR. */
  path: z.string().regex(/^\//),
  observation: z.string().min(1),
  why: z.string().min(1),
  evidenceIds: z.array(z.string()).default([]),
  /** The smallest causal repair, in the closed vocabulary the refiner is allowed to apply. */
  repair: z.object({
    kind: z.enum(['set_token', 'set_axis_descriptor', 'set_decision_rationale', 'add_decision_evidence', 'set_contract_field']),
    path: z.string().regex(/^\//),
    value: z.unknown(),
  }).optional(),
  confidence: z.number().min(0).max(1),
});
export type CritiqueFinding = z.infer<typeof critiqueFindingSchema>;

export const critiqueReportSchema = z.object({
  schemaVersion: z.literal(1),
  criticId: z.string().min(1),
  dimension: critiqueDimensionSchema,
  /** Which candidate this report is about, or the whole matrix for a set-level critic. */
  subject: z.union([z.object({ kind: z.literal('direction'), directionId: z.string().min(1) }), z.object({ kind: z.literal('matrix') })]),
  /** Criticmate's decomposition, attached as artefacts rather than free reasoning. */
  perception: z.array(z.string().min(1)).min(1),
  comprehension: z.array(z.string().min(1)).min(1),
  scores: z.array(z.object({ dimension: critiqueDimensionSchema, score: z.number().int().min(0).max(4), evidence: z.string().min(1) })).min(1),
  findings: z.array(critiqueFindingSchema).max(12).default([]),
  /** A critic that cannot decide says so; that escalates to the captain instead of inventing precision. */
  abstain: z.boolean().default(false),
  summary: z.string().min(1),
}).strict();
export type CritiqueReport = z.infer<typeof critiqueReportSchema>;

/**
 * The schema a critic seat's answer is held to: the report has to score the one
 * rubric that seat was given, so an answer that scored only somebody else's
 * rubric is an artefact problem and buys the single corrective re-invocation.
 */
export const critiqueReportSchemaFor = (dimension: CritiqueDimension) => critiqueReportSchema.refine(
  (report) => report.scores.some((entry) => entry.dimension === dimension),
  { path: ['scores'], message: `At least one score must name ${dimension}, the only rubric this critic was given.` },
);

export function blockingFindings(report: CritiqueReport): CritiqueFinding[] {
  return report.findings.filter((finding) => finding.severity === 'veto' || finding.severity === 'error');
}

export function belowRubric(report: CritiqueReport): Array<{ dimension: CritiqueDimension; score: number; evidence: string }> {
  return report.scores.filter((entry) => entry.score < RUBRIC_MINIMUM).map((entry) => ({ dimension: entry.dimension, score: entry.score, evidence: entry.evidence }));
}

/**
 * The art director writes plans for every candidate, but only the approved
 * direction is ever generated. A plan carries the negatives and the licence
 * expectation up front so provenance is never reconstructed after the fact. A
 * direction whose contract admits no generated source is never asked for a plan,
 * so an answer here always carries at least one, and each carries an id of its
 * own because the asset it becomes is named after it.
 */
export const imagePromptPlanSchemaFor = (directionId: IdentityAxisBriefId) => z.object({
  schemaVersion: z.literal(1),
  directionId: z.literal(directionId),
  plans: z.array(z.object({
    id: z.string().min(1),
    role: z.enum(['hero', 'proof', 'texture', 'portrait', 'diagram']),
    prompt: z.string().min(24),
    negatives: z.array(z.string().min(1)).min(1),
    aspect: z.enum(['1:1', '3:2', '2:3', '16:9', '4:5']),
    /** Which axis of the direction the image is there to carry. */
    axis: divergenceAxisSchema,
    alt: z.string().min(1),
    licenceExpectation: z.string().min(1),
  })).min(1).max(4).refine(
    (plans) => new Set(plans.map((plan) => plan.id)).size === plans.length,
    { message: 'Each plan needs an id of its own: the asset id, and the licence and provenance recorded under it, are derived from it.' },
  ),
}).strict();
export type ImagePromptPlan = z.infer<ReturnType<typeof imagePromptPlanSchemaFor>>;

/**
 * What a director returns beside its patch. The axis keys are assigned by the
 * seat and the palette signature is measured from the tokens, so the only part
 * a model contributes here is the descriptor: what its axis choice means. A
 * model therefore cannot claim divergence it did not produce. The seat the task
 * was issued for is pinned in that task's schema, so a director answering for
 * another seat is a schema violation that buys the one corrective
 * re-invocation instead of costing the branch.
 */
export const directionVectorDraftSchemaFor = (directionId: IdentityAxisBriefId) => z.object({
  schemaVersion: z.literal(1),
  directionId: z.literal(directionId),
  label: z.string().min(1),
  descriptors: z.object({
    composition: z.string().min(8), typography: z.string().min(8), materiality: z.string().min(8),
    color: z.string().min(8), imagery: z.string().min(8), motion: z.string().min(8),
  }),
  /** What this direction says must stay constant across the whole fan-out. */
  constants: z.array(z.string().min(1)).min(1),
  /** Pairs of moves this direction refuses to combine, with the reason. */
  incompatibilities: z.array(z.object({ a: z.string().min(1), b: z.string().min(1), reason: z.string().min(1) })).default([]),
}).strict();
export type DirectionVectorDraft = z.infer<ReturnType<typeof directionVectorDraftSchemaFor>>;
