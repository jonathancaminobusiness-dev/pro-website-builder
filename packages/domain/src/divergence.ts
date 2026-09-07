import { z } from 'zod';
import { paletteSignaturesMatch } from './color.js';

/**
 * The six axes the approved plan uses to decide whether three identity
 * directions are genuinely different proposals or one proposal wearing three
 * coats of paint. The vocabulary is closed on purpose: an axis value is a
 * strategy, never a raw visual value, so "the same layout with another hue"
 * cannot be spelled as a different axis.
 */
export const divergenceAxisSchema = z.enum(['composition', 'typography', 'materiality', 'color', 'imagery', 'motion']);
export type DivergenceAxis = z.infer<typeof divergenceAxisSchema>;
export const divergenceAxes: DivergenceAxis[] = divergenceAxisSchema.options;

export const axisKeyVocabulary: Record<DivergenceAxis, readonly string[]> = {
  composition: ['asymmetric-editorial', 'modular-grid', 'centered-classical', 'stacked-column', 'diagonal-collage', 'margin-driven'],
  typography: ['serif-display-contrast', 'grotesque-monospace-pair', 'single-family-optical-scale', 'condensed-headline', 'humanist-book'],
  materiality: ['paper-ink', 'engineered-surface', 'flat-pigment', 'woven-textile', 'printed-matter', 'cast-relief'],
  color: ['low-chroma-neutral', 'duotone-contrast', 'earth-pigment', 'monochrome-ink', 'saturated-signal', 'high-key-pastel'],
  imagery: ['documentary-photo', 'technical-diagram', 'no-photography', 'macro-texture', 'line-illustration', 'archival-collage'],
  motion: ['no-motion', 'weighted-settle', 'mechanical-step', 'typographic-reveal', 'parallax-depth'],
};

export const axisValueSchema = z.object({
  key: z.string().min(1),
  descriptor: z.string().min(8, 'An axis value must say what the strategy means for this direction.'),
});
export type AxisValue = z.infer<typeof axisValueSchema>;

export const paletteSignatureSchema = z.object({
  entries: z.array(z.string()).min(1),
  unparsed: z.array(z.string()).default([]),
});

export const directionVectorSchema = z.object({
  directionId: z.string().min(1),
  label: z.string().min(1),
  axes: z.object({
    composition: axisValueSchema, typography: axisValueSchema, materiality: axisValueSchema,
    color: axisValueSchema, imagery: axisValueSchema, motion: axisValueSchema,
  }),
  /** Hue-free fingerprint of this direction's colour tokens; see `packages/domain/src/color.ts`. */
  paletteSignature: paletteSignatureSchema,
}).superRefine((vector, ctx) => {
  for (const axis of divergenceAxes) {
    const allowed = axisKeyVocabulary[axis];
    if (!allowed.includes(vector.axes[axis].key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['axes', axis, 'key'], message: `Axis ${axis} does not accept the key ${vector.axes[axis].key}; use one of ${allowed.join(', ')}.` });
    }
  }
});
export type DirectionVector = z.infer<typeof directionVectorSchema>;

export const MINIMUM_DISTINCT_AXES = 4;

export const divergenceSpecSchema = z.object({
  directionId: z.string().min(1),
  /** Every direction in the fan-out, including this one, so a single document can be linted against the whole set. */
  matrix: z.array(directionVectorSchema).min(2),
  /** What the fan-out deliberately holds constant, so divergence is a decision and not an accident. */
  constants: z.array(z.string().min(1)).min(1),
  incompatibilities: z.array(z.object({ a: z.string().min(1), b: z.string().min(1), reason: z.string().min(1) })).default([]),
}).superRefine((spec, ctx) => {
  const ids = spec.matrix.map((vector) => vector.directionId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['matrix'], message: 'A divergence matrix must not list the same direction twice.' });
  if (!ids.includes(spec.directionId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['directionId'], message: `The matrix does not contain the direction ${spec.directionId} it belongs to.` });
});
export type DivergenceSpec = z.infer<typeof divergenceSpecSchema>;

export const evidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['brief', 'interview', 'artifact', 'constraint', 'assumption']),
  quote: z.string().min(1),
  source: z.string().min(1),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const decisionRecordSchema = z.object({
  id: z.string().min(1),
  /** What was decided, addressed as `tokens.<token path>` or one of the governed contract fields. */
  choice: z.string().min(1),
  axis: divergenceAxisSchema.optional(),
  evidenceIds: z.array(z.string().min(1)).default([]),
  rationale: z.string().optional(),
});
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

export const rejectedAlternativeSchema = z.object({
  directionId: z.string().min(1),
  label: z.string().min(1),
  reason: z.string().min(1),
});

/** Contract fields that must carry a decision record alongside every token. */
export const governedContractFields = ['direction.thesis', 'gridGrammar.columns', 'imagery.treatment', 'iconography.family', 'content.voice'] as const;

export const MINIMUM_RATIONALE_LENGTH = 12;

export function isGroundedDecision(decision: DecisionRecord, evidenceIds: ReadonlySet<string>): boolean {
  if (decision.evidenceIds.length > 0 && decision.evidenceIds.every((id) => evidenceIds.has(id))) return true;
  if ((decision.rationale ?? '').trim().length >= MINIMUM_RATIONALE_LENGTH) return true;
  return decision.axis !== undefined;
}

export interface AxisComparison { axis: DivergenceAxis; distinct: boolean; reason: string; }
export interface DirectionComparison { a: string; b: string; comparisons: AxisComparison[]; distinctAxes: DivergenceAxis[]; hueOnlyColor: boolean; }

/**
 * Compares two directions axis by axis. The colour axis is the one the plan
 * calls out by name: a different colour strategy only counts when the palettes
 * also differ once hue is removed, so swapping the hue never buys a direction.
 */
export function compareDirections(a: DirectionVector, b: DirectionVector): DirectionComparison {
  const comparisons: AxisComparison[] = divergenceAxes.map((axis) => {
    const left = a.axes[axis];
    const right = b.axes[axis];
    if (left.key === right.key) return { axis, distinct: false, reason: `Both directions use the ${axis} strategy ${left.key}.` };
    if (axis !== 'color') return { axis, distinct: true, reason: `${left.key} versus ${right.key}.` };
    if (paletteSignaturesMatch(a.paletteSignature, b.paletteSignature)) {
      return { axis, distinct: false, reason: `${left.key} versus ${right.key}, but the palettes share one lightness and chroma fingerprint: only the hue changed.` };
    }
    return { axis, distinct: true, reason: `${left.key} versus ${right.key}, with different lightness and chroma.` };
  });
  const colorComparison = comparisons.find((entry) => entry.axis === 'color')!;
  return {
    a: a.directionId,
    b: b.directionId,
    comparisons,
    distinctAxes: comparisons.filter((entry) => entry.distinct).map((entry) => entry.axis),
    hueOnlyColor: !colorComparison.distinct && a.axes.color.key !== b.axes.color.key,
  };
}

export function compareDivergenceMatrix(matrix: DirectionVector[]): DirectionComparison[] {
  const pairs: DirectionComparison[] = [];
  for (let left = 0; left < matrix.length; left += 1) {
    for (let right = left + 1; right < matrix.length; right += 1) pairs.push(compareDirections(matrix[left]!, matrix[right]!));
  }
  return pairs;
}
