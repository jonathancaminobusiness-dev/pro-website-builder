import { hashJson, RELEASE_RUBRIC_MINIMUM, releaseGateReportSchema, type EvidenceArtifact, type ParityReport, type ReleaseCritique, type ReleaseGateReport, type ReleaseSummary, type ReleaseVeto } from '@pwb/domain';
import type { CompiledSite } from '@pwb/export';
import { evidenceCoverage, evidenceVetoes, partitionEvidence } from './evidence.js';
import { RELEASE_CRITICS } from './critics.js';
import { aggregateVetoes } from './veto-catalog.js';

export interface ReleaseGateInput {
  compiled: CompiledSite;
  evidence: EvidenceArtifact[];
  critiques: ReleaseCritique[];
  parity: ParityReport;
  approved: {
    versionId: string;
    irHash: string;
    /** Path and hash of every file the approved document compiles to. */
    renderedFiles: Array<[string, string]>;
  };
  releasedVersionId: string;
  refinementCycles: number;
  escalations: string[];
  /** Read for display only; it can never change a verdict. */
  summary?: ReleaseSummary;
}

/**
 * The gate's own veto: what the release would publish must be what the captain
 * approved.
 *
 * It compares the compiled files, not the document, so the refiner recording a
 * finding in the review record is not a divergence while a token or a page that
 * changed the rendered output is. Comparing the document hash instead would
 * either be tautological — the bundle always comes from the document it was
 * compiled from — or would fire on bookkeeping.
 */
function divergenceVetoes(input: ReleaseGateInput): ReleaseVeto[] {
  const vetoes: ReleaseVeto[] = [];
  const released = input.compiled.files.map((file) => [file.path, file.hash] as [string, string]);
  if (hashJson(released) !== hashJson(input.approved.renderedFiles)) {
    const approvedPaths = new Map(input.approved.renderedFiles);
    const changed = [
      ...released.filter(([path, hash]) => approvedPaths.get(path) !== hash).map(([path]) => path),
      ...input.approved.renderedFiles.filter(([path]) => !released.some(([other]) => other === path)).map(([path]) => path),
    ];
    vetoes.push({ id: 'RELEASE_DIVERGES_FROM_APPROVED', detector: 'gate', where: input.approved.versionId, detail: `O release mudou depois da versão aprovada ${input.approved.versionId} em: ${[...new Set(changed)].sort().join(', ')}.` });
  }
  for (const route of input.parity.routes) {
    if (route.matched) continue;
    vetoes.push({ id: 'RELEASE_DIVERGES_FROM_APPROVED', detector: 'gate', where: route.route, detail: `Preview e release divergem em ${route.route}: ${route.differences.join(' ')}` });
  }
  return vetoes;
}

/**
 * Builds the Gate 3 report.
 *
 * Every veto is recomputed here from the compiled bundle, the raw evidence
 * artifacts and the approved version. Critiques contribute rubric scores and
 * escalations and nothing else — a critic cannot introduce a veto and cannot
 * clear one — and the summary is carried along without ever being read for a
 * verdict. Only the captain approves; `blocked` says whether they may.
 */
export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateReport {
  // Only a measurement taken against this exact bundle says anything about it.
  const evidence = partitionEvidence(input.evidence, { digest: input.compiled.digest, irHash: input.compiled.irHash });
  const vetoes = aggregateVetoes(input.compiled.vetoes, evidenceVetoes(evidence.credited), divergenceVetoes(input));
  const rubric = input.critiques
    .map((critique) => ({ dimension: critique.dimension, score: critique.rubricScore, verdict: critique.verdict }))
    .sort((a, b) => (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0));

  const reported = new Set(input.critiques.map((critique) => critique.dimension));
  const escalations = [
    ...input.escalations,
    ...RELEASE_CRITICS.filter((critic) => !reported.has(critic.dimension)).map((critic) => `O crítico de ${critic.dimension} não entregou parecer; a evidência dessa dimensão está ausente.`),
    ...rubric.filter((row) => row.score < RELEASE_RUBRIC_MINIMUM).map((row) => `A dimensão ${row.dimension} pontuou ${row.score}/4, abaixo do mínimo ${RELEASE_RUBRIC_MINIMUM}.`),
    ...rubric.filter((row) => row.verdict === 'uncertain').map((row) => `O crítico de ${row.dimension} respondeu incerto; a decisão sobe para o capitão.`),
    ...evidenceCoverage(evidence.credited).missing,
    ...evidence.escalations,
    // An asset the bundle does not ship cannot be published without terms, so it
    // is named for the captain rather than blocking the release.
    ...input.compiled.licenses.warnings.map((warning) => warning.detail),
    ...(input.releasedVersionId === input.approved.versionId ? [] : [`O patch-refiner produziu a versão ${input.releasedVersionId} a partir da aprovada ${input.approved.versionId}; o capitão aprova o documento refinado.`]),
  ];

  return releaseGateReportSchema.parse({
    stage: 'finalization',
    bundleDigest: input.compiled.digest,
    irHash: input.compiled.irHash,
    approvedVersionId: input.approved.versionId,
    releasedVersionId: input.releasedVersionId,
    rendererVersion: input.compiled.rendererVersion,
    compilerVersion: input.compiled.compilerVersion,
    blocked: vetoes.length > 0,
    vetoes,
    rubric,
    parity: input.parity,
    evidence: evidence.credited,
    refinementCycles: input.refinementCycles,
    escalations: [...new Set(escalations)],
    ...(input.summary ? { summary: input.summary } : {}),
    approverRole: 'captain',
  });
}
