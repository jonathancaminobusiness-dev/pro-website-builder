import { z } from 'zod';
import { paletteSignature } from './color.js';
import { decisionRecordSchema, divergenceAxes, divergenceSpecSchema, evidenceSchema, rejectedAlternativeSchema, type DivergenceAxis } from './divergence.js';
import { documentRules } from './rules.js';
import { flattenTokens, resolveTokens, tokenGroupSchema } from './tokens.js';

const provenanceSchema = z.object({
  source: z.string(), author: z.string(), license: z.string(), date: z.string(), hash: z.string(),
});

/**
 * A breakpoint is emitted as a container query, and a container is never wider than the viewport that
 * holds it, so a breakpoint at or below the narrowest capture width is on in every single capture.
 */
const NARROWEST_CONTAINER_PX = 320;

function referencedLengthPx(reference: string, values: Record<string, string | number | boolean>): number | undefined {
  const match = /^\{([^}]+)\}$/.exec(reference);
  const raw = match ? values[match[1]!] : undefined;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const size = /^(\d*\.?\d+)(px|rem|em)?$/.exec(raw.trim());
  if (!size) return undefined;
  const amount = Number.parseFloat(size[1]!);
  if (!Number.isFinite(amount)) return undefined;
  return size[2] === 'rem' || size[2] === 'em' ? amount * 16 : amount;
}

export const identitySpecSchema = z.object({
  meta: z.object({ id: z.string(), version: z.string(), locale: z.string(), status: z.enum(['draft', 'approved']) }),
  strategy: z.object({
    audience: z.string(), job: z.string(), promise: z.string(), proof: z.array(z.string()), exclusions: z.array(z.string()),
    /** Briefing evidence a decision record may cite; see the ID-003 rule in `@pwb/linter`. */
    evidence: z.array(evidenceSchema).default([]),
  }),
  direction: z.object({
    thesis: z.string(), tension: z.string(), materiality: z.string(), density: z.enum(['airy', 'balanced', 'dense']), divergenceVector: z.array(z.string()).min(3), rationale: z.string(),
    /** The typed divergence matrix this direction was produced under; see the DIV-030 rule in `@pwb/linter`. */
    divergence: divergenceSpecSchema.optional(),
    rejectedAlternatives: z.array(rejectedAlternativeSchema).default([]),
  }),
  tokens: tokenGroupSchema,
  tokenRoles: z.object({ surface: z.string(), text: z.string(), bodyTypeface: z.string(), baseSpacing: z.string(), sectionSpacing: z.string() }),
  gridGrammar: z.object({
    maxWidthToken: z.string(), columns: z.number().int().positive(), gutterToken: z.string(), rhythmToken: z.string(),
    /** The container widths the layout may transform at, in ascending order; the only breakpoints a composer may use. */
    breakpointTokens: z.array(z.string()).min(2),
    responsive: z.array(z.object({ container: z.string(), rule: z.string() })),
  }),
  imagery: z.object({ treatment: z.string(), focalPolicy: z.string(), allowedSources: z.array(z.string()) }),
  iconography: z.object({ family: z.string(), strokeToken: z.string(), naming: z.string() }),
  content: z.object({ voice: z.string(), message: z.string(), allowedTerms: z.array(z.string()), forbiddenTerms: z.array(z.string()) }),
  do: z.array(z.string()),
  dont: z.array(z.string()),
  forbiddenDefaults: z.object({ fonts: z.array(z.string()), palettes: z.array(z.string()), motifs: z.array(z.string()) }),
  governance: z.object({ approverRole: z.literal('captain'), rationaleRequired: z.boolean(), changePolicy: z.string() }),
  provenance: provenanceSchema,
  schemes: z.object({ dark: z.record(z.string()) }).partial().optional(),
  /** One record per token and per governed contract field; ID-003 blocks Gate 1 when a choice has none. */
  decisions: z.array(decisionRecordSchema).default([]),
}).superRefine((identity, ctx) => {
  const paths = flattenTokens(identity.tokens);
  for (const [role, path] of Object.entries(identity.tokenRoles)) {
    if (!paths.has(path)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tokenRoles', role], message: `${documentRules.tokenRoles} Token role ${role} points at ${path}, which the identity does not define.` });
  }
  let values: Record<string, string | number | boolean> = {};
  try { values = resolveTokens(identity.tokens).values; } catch { values = {}; }
  let narrower = NARROWEST_CONTAINER_PX;
  for (const [index, reference] of identity.gridGrammar.breakpointTokens.entries()) {
    const width = referencedLengthPx(reference, values);
    if (width === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gridGrammar', 'breakpointTokens', index], message: `The grid grammar breakpoint ${reference} does not resolve to a dimension token of this identity.` });
      continue;
    }
    if (width <= narrower) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gridGrammar', 'breakpointTokens', index], message: `The grid grammar breakpoint ${reference} resolves to ${width}px, which is not above ${narrower}px; a container that narrow already satisfies it, so the query transforms nothing.` });
      continue;
    }
    narrower = width;
  }
  for (const [target, source] of Object.entries(identity.schemes?.dark ?? {})) {
    if (!paths.has(target)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['schemes', 'dark', target], message: `The dark scheme overrides ${target}, which the identity does not define.` });
    if (!paths.has(source)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['schemes', 'dark', target], message: `The dark scheme reads ${source}, which the identity does not define.` });
  }
});

export function declaresDarkScheme(identity: IdentitySpec): boolean {
  return Object.keys(identity.schemes?.dark ?? {}).length > 0;
}

export type IdentitySpec = z.infer<typeof identitySpecSchema>;

/** The colour values an identity actually resolves to, which is what a palette fingerprint is measured from. */
export function identityColorValues(identity: IdentitySpec): string[] {
  const { values, types } = resolveTokens(identity.tokens);
  return Object.entries(values)
    .filter(([path, value]) => typeof value === 'string' && (types[path] === 'color' || path.startsWith('color.')))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, value]) => String(value));
}

/**
 * What the document itself shows on each divergence axis, measured from the
 * tokens and the contract rather than declared. Two directions whose seats
 * demanded opposite strategies but whose documents carry the same grid, the
 * same families, the same palette, the same imagery policy and the same motion
 * are not divergent, and DIV-030 compares these signals to say so.
 */
export function measuredAxisSignals(identity: IdentitySpec): Record<DivergenceAxis, string> {
  const { values } = resolveTokens(identity.tokens);
  const group = (prefix: string): string => Object.entries(values)
    .filter(([path]) => path.startsWith(`${prefix}.`))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, value]) => `${path}=${String(value)}`)
    .join(' ');
  const signals: Record<DivergenceAxis, string> = {
    composition: `columns=${identity.gridGrammar.columns}`,
    typography: group('type'),
    materiality: `density=${identity.direction.density} ${group('radius')}`,
    color: paletteSignature(identityColorValues(identity)).entries.join(' '),
    imagery: `sources=${[...identity.imagery.allowedSources].sort().join(',')} treatment=${identity.imagery.treatment} focal=${identity.imagery.focalPolicy}`,
    motion: group('motion'),
  };
  return Object.fromEntries(divergenceAxes.map((axis) => [axis, signals[axis] || `${axis}=unstated`])) as Record<DivergenceAxis, string>;
}
