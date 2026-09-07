import { z } from 'zod';

/**
 * Release vetoes are objective, non-negotiable stop conditions for stage three.
 * A veto is never scored, ranked or averaged: one veto blocks Gate 3 outright.
 * The catalogue that explains each id and its detector lives in
 * `@pwb/stage-finalization`; only the identifiers are shared here so the
 * compiler and the finalization stage cannot drift apart.
 */
export const releaseVetoIdSchema = z.enum([
  'SECRET_IN_BUNDLE',
  'XSS_OR_JAVASCRIPT_URL',
  'UNSANITIZED_HTML',
  'ASSET_WITHOUT_LICENSE',
  'BUILD_FAILED',
  'BROKEN_PRIMARY_LINK',
  'CRITICAL_AA_REGRESSION',
  'RELEASE_DIVERGES_FROM_APPROVED',
]);

export const releaseVetoDetectorSchema = z.enum(['compiler', 'evidence', 'gate']);

export const releaseVetoSchema = z.object({
  id: releaseVetoIdSchema,
  detector: releaseVetoDetectorSchema,
  where: z.string(),
  detail: z.string(),
});

/** The five release critics. Each one is a separate read-only session. */
export const releaseCriticDimensionSchema = z.enum([
  'accessibility',
  'semantics-seo',
  'visual-regression',
  'asset-performance',
  'provenance-security',
]);

export const releaseSuggestionSchema = z.object({
  kind: z.enum(['token', 'constraint', 'crop', 'copy', 'order', 'metadata']),
  path: z.string().regex(/^\//, 'A suggestion must point at a JSON pointer inside the document.'),
  note: z.string().min(1),
});

export const releaseFindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['veto', 'error', 'warning', 'uncertain']),
  route: z.string(),
  nodeId: z.string().optional(),
  evidenceRef: z.string().min(1),
  cause: z.string().min(1),
  suggestion: releaseSuggestionSchema,
});

/**
 * A critic returns observations, never a document mutation. There is no patch
 * in this shape on purpose: only the patch-refiner turns findings into a Patch,
 * and only the Applier writes a version.
 */
export const releaseCritiqueSchema = z.object({
  taskId: z.string().min(1),
  dimension: releaseCriticDimensionSchema,
  verdict: z.enum(['pass', 'revise', 'uncertain']),
  rubricScore: z.number().int().min(0).max(4),
  summary: z.string().min(1),
  findings: z.array(releaseFindingSchema),
});

export const evidenceArtifactSchema = z.object({
  id: z.string().min(1),
  runner: z.enum(['vitest', 'playwright', 'axe', 'lighthouse', 'compiler']),
  engine: z.enum(['node', 'chromium', 'firefox', 'webkit']),
  route: z.string(),
  state: z.string(),
  status: z.enum(['passed', 'failed']),
  path: z.string(),
  hash: z.string(),
  vetoes: z.array(releaseVetoSchema),
  metrics: z.record(z.number()),
  notes: z.array(z.string()),
});

export const parityReportSchema = z.object({
  matched: z.boolean(),
  routes: z.array(z.object({ route: z.string(), matched: z.boolean(), differences: z.array(z.string()) })),
});

/**
 * The release summarizer explains the release to a human. It holds no gate
 * authority: `gateAuthority` is a literal so no summary can ever claim one, and
 * `evaluateReleaseGate` recomputes every veto from the raw artifacts.
 */
export const releaseSummarySchema = z.object({
  headline: z.string().min(1),
  highlights: z.array(z.string()),
  openQuestions: z.array(z.string()),
  vetoCount: z.number().int().nonnegative(),
  gateAuthority: z.literal('none'),
});

export const releaseGateReportSchema = z.object({
  stage: z.literal('finalization'),
  bundleDigest: z.string().min(1),
  irHash: z.string().min(1),
  approvedVersionId: z.string().min(1),
  rendererVersion: z.string().min(1),
  compilerVersion: z.string().min(1),
  blocked: z.boolean(),
  vetoes: z.array(releaseVetoSchema),
  rubric: z.array(z.object({ dimension: releaseCriticDimensionSchema, score: z.number().int().min(0).max(4), verdict: z.enum(['pass', 'revise', 'uncertain']) })),
  parity: parityReportSchema,
  evidence: z.array(evidenceArtifactSchema),
  refinementCycles: z.number().int().min(0).max(2),
  escalations: z.array(z.string()),
  summary: releaseSummarySchema.optional(),
  approverRole: z.literal('captain'),
});

export type ReleaseVetoId = z.infer<typeof releaseVetoIdSchema>;
export type ReleaseVeto = z.infer<typeof releaseVetoSchema>;
export type ReleaseCriticDimension = z.infer<typeof releaseCriticDimensionSchema>;
export type ReleaseFinding = z.infer<typeof releaseFindingSchema>;
export type ReleaseCritique = z.infer<typeof releaseCritiqueSchema>;
export type EvidenceArtifact = z.infer<typeof evidenceArtifactSchema>;
export type ParityReport = z.infer<typeof parityReportSchema>;
export type ReleaseSummary = z.infer<typeof releaseSummarySchema>;
export type ReleaseGateReport = z.infer<typeof releaseGateReportSchema>;

/** The rubric minimum the plan sets for every absolute score. */
export const RELEASE_RUBRIC_MINIMUM = 3;
