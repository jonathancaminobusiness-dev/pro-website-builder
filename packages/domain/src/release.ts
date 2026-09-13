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
  // A critic has no veto power, so no finding can carry one: vetoes come only
  // from the compiler, the evidence runners and the gate.
  severity: z.enum(['error', 'warning', 'uncertain']),
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

/**
 * A measurement is only evidence about the release it was taken against, so
 * every artifact names that release. The gate credits an artifact only when both
 * identifiers match the bundle it is evaluating.
 */
export const evidenceArtifactSchema = z.object({
  id: z.string().min(1),
  runner: z.enum(['vitest', 'playwright', 'axe', 'lighthouse']),
  engine: z.enum(['node', 'chromium', 'firefox', 'webkit']),
  /** Digest of the compiled bundle the runner measured. */
  releaseDigest: z.string().min(1),
  /** Hash of the document that bundle was compiled from. */
  irHash: z.string().min(1),
  route: z.string(),
  state: z.string(),
  status: z.enum(['passed', 'failed']),
  path: z.string(),
  hash: z.string(),
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
  /** The version the captain approved coming into the stage. */
  approvedVersionId: z.string().min(1),
  /** The version the bundle was compiled from; it differs when the refiner changed the document. */
  releasedVersionId: z.string().min(1),
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

/**
 * One publication of one bundle, as it is written beside the bundle directory.
 *
 * It is read back from a file nothing in this process wrote — a hand-edit, a
 * half-flushed write, another tool — and it is the only durable home for the
 * captain's written acceptance, so it is parsed like any other document that
 * crosses a boundary rather than trusted for its type.
 */
export const releasePublicationSchema = z.object({
  digest: z.string().min(1),
  /** The acceptance this publication records; one per run's finalization gate. */
  acceptanceId: z.string().min(1),
  approvedVersionId: z.string().min(1),
  releasedVersionId: z.string().min(1),
  irHash: z.string().min(1),
  approverRole: z.string().min(1),
  rationale: z.string(),
  acceptedEscalations: z.array(z.string()),
});

export const releasePublicationsSchema = z.array(releasePublicationSchema);

export type ReleaseVetoId = z.infer<typeof releaseVetoIdSchema>;
export type ReleaseVeto = z.infer<typeof releaseVetoSchema>;
export type ReleaseCriticDimension = z.infer<typeof releaseCriticDimensionSchema>;
export type ReleaseFinding = z.infer<typeof releaseFindingSchema>;
export type ReleaseCritique = z.infer<typeof releaseCritiqueSchema>;
export type EvidenceArtifact = z.infer<typeof evidenceArtifactSchema>;
export type ParityReport = z.infer<typeof parityReportSchema>;
export type ReleaseSummary = z.infer<typeof releaseSummarySchema>;
export type ReleaseGateReport = z.infer<typeof releaseGateReportSchema>;
export type ReleasePublication = z.infer<typeof releasePublicationSchema>;

/** The rubric minimum the plan sets for every absolute score. */
export const RELEASE_RUBRIC_MINIMUM = 3;
